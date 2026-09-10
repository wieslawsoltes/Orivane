import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardDocument, makeObject, validateOperation, validateProps } from '../public/core/model.js';
import { History } from '../public/core/history.js';
import { Camera, SpatialIndex, hitObject, connectorPoints } from '../public/core/geometry.js';
import { createTemplate, templateCatalog } from '../public/core/templates.js';
const add = (doc, id = 'note', props = {}) => doc.transact([{ id, props: { type: 'sticky', x: 0, y: 0, w: 100, h: 100, text: 'Hello', fill: '#fff0a6', $deleted: false, ...props } }]);
test('Concurrent disjoint edits merge without loss', () => { const a = new BoardDocument('alice'), b = new BoardDocument('bob'); b.apply(add(a)); const one = a.transact([{ id: 'note', props: { x: 50 } }]), two = b.transact([{ id: 'note', props: { text: 'World' } }]); a.apply(two); b.apply(one); assert.equal(a.canonical(), b.canonical()); assert.equal(a.get('note').x, 50); assert.equal(a.get('note').text, 'World'); });
test('Concurrent character replacements preserve both contributions and ignore duplicates', () => { const a = new BoardDocument('a'), b = new BoardDocument('b'); const seed = add(a); b.apply(seed); const x = a.transact([{ id: 'note', props: { text: 'A' } }]), y = b.transact([{ id: 'note', props: { text: 'B' } }]); a.apply(y); b.apply(x); const c = new BoardDocument('c'); [y, x, seed, x, y].forEach(op => c.apply(op)); assert.equal(a.canonical(), b.canonical()); assert.equal(b.canonical(), c.canonical()); assert.equal(a.get('note').text, 'BA'); });
test('Delete tombstone is not undone by an unrelated later update', () => { const a = new BoardDocument('alice'), b = new BoardDocument('bob'); b.apply(add(a)); const del = a.transact([{ id: 'note', props: { $deleted: true } }]); const edit = b.transact([{ id: 'note', props: { text: 'Remote' } }]); a.apply(edit); b.apply(del); assert.equal(a.get('note'), null); assert.equal(a.canonical(), b.canonical()); });
test('History undo/redo restores create, move, delete', () => { const d = new BoardDocument('a'), h = new History(d); h.execute([{ id: 'a', props: { type: 'rect', x: 2, y: 3, w: 100, h: 80, $deleted: false } }]); assert.ok(d.get('a')); h.undo(); assert.equal(d.get('a'), null); h.redo(); assert.equal(d.get('a').x, 2); h.execute([{ id: 'a', props: { x: 10 } }]); h.undo(); assert.equal(d.get('a').x, 2); h.redo(); assert.equal(d.get('a').x, 10); h.execute([{ id: 'a', props: { $deleted: true } }]); h.undo(); assert.ok(d.get('a')); });
test('Undo preserves a remote replacement of the same property', () => { const d = new BoardDocument('a'), h = new History(d); add(d); h.execute([{ id: 'note', props: { text: 'Mine', x: 20 } }]); const r = new BoardDocument('z'); r.merge(d.snapshot()); d.apply(r.transact([{ id: 'note', props: { text: 'Theirs' } }])); h.undo(); assert.equal(d.get('note').text, 'Theirs'); assert.equal(d.get('note').x, 0); h.redo(); assert.equal(d.get('note').text, 'Theirs'); assert.equal(d.get('note').x, 20); });
test('Undo does not delete a newly-created object modified remotely', () => { const d = new BoardDocument('a'), h = new History(d); h.execute([{ id: 'note', props: { type: 'sticky', text: 'Mine', $deleted: false } }]); d.apply({ id: 'remote', actor: 'b', clock: 10, changes: [{ id: 'note', props: { text: 'Theirs' } }] }); h.undo(); assert.equal(d.get('note').text, 'Theirs'); });
test('Malformed snapshot is atomically rejected', () => { const d = new BoardDocument('a'); add(d); const before = d.canonical(), snap = d.snapshot(); snap.records.push({ id: 'bad', fields: { type: { value: 'not-a-type', stamp: [3, 'x'] } } }); assert.throws(() => d.merge(snap)); assert.equal(d.canonical(), before); });
test('Prototype pollution and untrusted raster URLs rejected', () => { assert.throws(() => validateProps(JSON.parse('{"__proto__":{"polluted":true}}'))); assert.throws(() => validateProps({ src: 'https://host/track.png' })); assert.throws(() => validateProps({ src: 'data:image/svg+xml;base64,abcd' })); assert.throws(() => validateOperation({ id: 'op', actor: 'x', clock: NaN, changes: [] })); assert.equal({}.polluted, undefined); });
test('Camera zoom keeps cursor anchored in world coordinates', () => { const c = new Camera(); c.x = -200; c.y = 40; c.zoom = .7; const p = { x: 410, y: 340 }, before = c.world(p); c.zoomAt(2, p); assert.ok(Math.abs(c.world(p).x - before.x) < 1e-9); assert.ok(Math.abs(c.world(p).y - before.y) < 1e-9); });
test('Spatial hash handles large frames and point queries', () => { const index = new SpatialIndex(100); const objects = [makeObject('rect', 100, 100, { id: 'one', w: 80, h: 60 }), makeObject('frame', -5000, -5000, { id: 'large', w: 10000, h: 10000 })]; index.rebuild(objects, () => null); assert.deepEqual([...index.query({ x: 120, y: 120, w: 1, h: 1 })].sort(), ['large', 'one']); assert.deepEqual([...index.query({ x: 500, y: 500, w: 1, h: 1 })], ['large']); });
test('Attached connectors follow moved nodes and hit testing uses lines', () => { const a = makeObject('rect', 0, 0, { id: 'a', w: 100, h: 100 }), b = makeObject('rect', 400, 0, { id: 'b', w: 100, h: 100 }), line = makeObject('connector', 100, 50, { w: 300, h: 0, from: { id: 'a', side: 'right' }, to: { id: 'b', side: 'left' }, route: 'straight' }); const lookup = id => id === 'a' ? a : b; assert.deepEqual(connectorPoints(line, lookup), [{ x: 100, y: 50 }, { x: 400, y: 50 }]); b.x = 600; assert.equal(connectorPoints(line, lookup)[1].x, 600); assert.ok(hitObject(line, { x: 350, y: 50 }, 5, lookup)); assert.ok(!hitObject(line, { x: 350, y: 100 }, 5, lookup)); });
test('Every template is composed of valid editable objects with valid attachments', () => { for (const t of templateCatalog) {
    const objects = createTemplate(t.id), doc = new BoardDocument('test');
    assert.ok(objects.length >= 2, t.id);
    doc.transact(objects.map(({ id, ...props }) => ({ id, props })));
    for (const o of doc.objects())
        if (o.type === 'connector') {
            if (o.from)
                assert.ok(doc.get(o.from.id));
            if (o.to)
                assert.ok(doc.get(o.to.id));
        }
} });
test('Two hundred permuted concurrent edits converge', () => { const a = new BoardDocument('a'), b = new BoardDocument('b'), c = new BoardDocument('c'), seed = add(a); b.apply(seed); c.apply(seed); const ops = []; for (let i = 0; i < 200; i++) {
    const d = i % 2 ? a : b;
    ops.push(d.transact([{ id: 'note', props: { [i % 3 ? 'x' : 'text']: i % 3 ? i : String(i) } }]));
} for (const op of ops.toReversed())
    a.apply(op); for (const op of ops)
    b.apply(op); for (const op of [...ops.slice(100), ...ops.slice(0, 100).reverse()])
    c.apply(op); assert.equal(a.canonical(), b.canonical()); assert.equal(a.canonical(), c.canonical()); });
