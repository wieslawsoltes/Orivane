import { RichSequence, textKey, validateTextChange, validateMarks, safeLink } from './richtext.js';
/** A property-level LWW replicated map. Stamps are [Lamport counter, actor ID].
 * Deletion is a tombstone: properties arriving late never resurrect an object.
 * Text and table cells use character-level RGA sequences with per-character marks.
 */
export const FORMAT = 'orivane/2';
export const LEGACY_FORMAT = 'orivane/1';
export const TYPES = new Set(['sticky', 'rect', 'ellipse', 'diamond', 'triangle', 'text', 'frame', 'connector', 'pen', 'image', 'card', 'table', 'comment', 'chat', 'vote', 'meta', 'session']);
export const uid = (prefix = 'o') => `${prefix}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
export const clone = value => value === undefined ? undefined : structuredClone(value);
export function compareStamp(a, b) { return !b ? 1 : a[0] - b[0] || (a[1] === b[1] ? 0 : a[1] > b[1] ? 1 : -1); }
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const allowed = new Set(['type', 'x', 'y', 'w', 'h', 'z', 'text', 'fill', 'stroke', 'strokeWidth', 'fontSize', 'fontFamily', 'bold', 'italic', 'align', 'rotation', 'opacity', 'radius', 'dash', 'arrowStart', 'arrowEnd', 'route', 'from', 'to', 'points', 'src', 'group', 'locked', 'tag', 'assignee', 'status', 'due', 'rows', 'cols', 'cells', 'title', 'author', 'authorId', 'parent', 'resolved', 'created', 'target', 'session', 'limit', 'endAt', 'running', 'paused', 'ended', 'name', 'value', 'color', 'richText', 'external', 'externalUrl', 'externalUpdated', 'collapsed', 'layout', 'media', 'url', '$deleted']);
export function validId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_:@.\-]{1,180}$/.test(id) && !forbidden.has(id); }
export function validateProps(props) {
    if (!props || typeof props !== 'object' || Array.isArray(props) || Object.keys(props).length > 64)
        throw Error('Invalid properties');
    for (const [key, value] of Object.entries(props)) {
        if (!allowed.has(key) || forbidden.has(key))
            throw Error(`Unsupported property: ${key}`);
        if (value === null)
            continue;
        if (['text','title','name','fontFamily','align','route','group','tag','assignee','status','due','author','authorId','parent','target','session','external','externalUrl','layout','media','url'].includes(key) && typeof value !== 'string') throw Error('Expected string property: ' + key);
        if (['bold','italic','dash','arrowStart','arrowEnd','locked','resolved','running','ended','collapsed','$deleted'].includes(key) && typeof value !== 'boolean') throw Error('Expected boolean property: ' + key);
        if (['z','fontSize','strokeWidth','rotation','opacity','radius','rows','cols','created','limit','endAt','paused','externalUpdated'].includes(key) && typeof value !== 'number') throw Error('Expected numeric property: ' + key);
        if (key === 'opacity' && (value < 0 || value > 1)) throw Error('Opacity must be between zero and one');
        if (key === 'rows' && (!Number.isInteger(value) || value < 1 || value > 100) || key === 'cols' && (!Number.isInteger(value) || value < 1 || value > 30)) throw Error('Invalid table dimensions');
        if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e15))
            throw Error('Invalid number');
        if (['x', 'y', 'w', 'h'].includes(key) && (typeof value !== 'number' || Math.abs(value) > 1e7))
            throw Error('Geometry outside supported range');
        if (['w', 'h'].includes(key) && value < 0)
            throw Error('Negative dimensions');
        if (['fontSize', 'strokeWidth'].includes(key) && (typeof value !== 'number' || value < 0 || value > 2000))
            throw Error('Invalid size');
        if (key === 'type' && !TYPES.has(value))
            throw Error('Unknown object type');
        if (typeof value === 'string' && value.length > (key === 'src' ? 3000000 : 40000))
            throw Error('Text exceeds limit');
        if (key === 'src' && (typeof value !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)))
            throw Error('Images must be embedded raster data');
        if (['fill', 'stroke', 'color'].includes(key) && (typeof value !== 'string' || !(/^(#[a-fA-F0-9]{6}|transparent)$/.test(value))))
            throw Error('Invalid color');
        if (key === 'points' && (!Array.isArray(value) || value.length > 15000 || value.some(p => !Array.isArray(p) || p.length < 2 || p.length > 3 || p.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e7))))
            throw Error('Invalid stroke points');
        if (key === 'cells' && (!Array.isArray(value) || value.length > 100 || value.some(r => !Array.isArray(r) || r.length > 30 || r.some(c => typeof c !== 'string' || c.length > 5000))))
            throw Error('Invalid table');
        if (key === 'richText') {
            if (!Array.isArray(value) || value.length > 40000 || value.some(r => !r || typeof r.text !== 'string' || r.text.length > 40000 || Object.keys(r).some(k => !['text', 'marks'].includes(k)))) throw Error('Invalid rich text runs');
            if (value.reduce((n, r) => n + r.text.length, 0) > 40000) throw Error('Rich text exceeds limit');
            for (const r of value) validateMarks(r.marks || {});
        }
        if (['externalUrl', 'url'].includes(key) && value) safeLink(value);
        if (typeof value === 'object' && !['points', 'cells', 'from', 'to', 'richText'].includes(key))
            throw Error('Unexpected nested object');
        if (['from', 'to'].includes(key) && (typeof value !== 'object' || !validId(value.id) || Object.keys(value).some(k => !['id', 'side'].includes(k)) || !['auto', 'left', 'right', 'top', 'bottom'].includes(value.side || 'auto')))
            throw Error('Invalid connector attachment');
    }
    return true;
}
export function validateOperation(op) {
    if (!op || !validId(op.actor) || !validId(op.id) || !Number.isSafeInteger(op.clock) || op.clock < 1 || op.clock > 1e12)
        throw Error('Invalid operation stamp');
    if (!Array.isArray(op.changes) || op.changes.length > 10000 || (!op.changes.length && !op.text?.length))
        throw Error('Invalid operation batch');
    if (op.text !== undefined) {
        if (!Array.isArray(op.text) || op.text.length > 3000) throw Error('Invalid text batch');
        const targets = new Set(); let count = 0;
        for (const t of op.text) { validateTextChange(t, [op.clock, op.actor]); const key = textKey(t.id, t.field); if (targets.has(key)) throw Error('Duplicate text field'); targets.add(key); count += t.actions.length; }
        if (count > 100000) throw Error('Text transaction too large');
    }
    const ids = new Set();
    for (const c of op.changes) {
        if (!c || !validId(c.id) || ids.has(c.id))
            throw Error('Invalid or repeated object ID');
        ids.add(c.id);
        validateProps(c.props);
    }
    return true;
}
export class BoardDocument {
    constructor(actor = uid('actor')) { this.actor = actor; this.clock = 0; this.records = new Map(); this.texts = new Map(); this.listeners = new Set(); this.revision = 0; this.cached = null; }
    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    get(id, includeDeleted = false) {
        const r = this.records.get(id); if (!r) return null;
        const o = { id }; for (const [k, v] of Object.entries(r)) o[k] = clone(v.value);
        const text = this.texts.get(textKey(id));
        if (text && compareStamp(text.epoch, r.text?.stamp) >= 0) { o.text = text.string(); o.richText = text.runs(); }
        if (o.type === 'table') {
            for (let row = 0; row < (o.rows || 0); row++) for (let col = 0; col < (o.cols || 0); col++) {
                const seq = this.texts.get(textKey(id, `cell:${row}:${col}`));
                if (seq && compareStamp(seq.epoch, r.cells?.stamp) >= 0) { o.cells ||= []; o.cells[row] ||= []; o.cells[row][col] = seq.string(); }
            }
        }
        return o.$deleted && !includeDeleted ? null : o;
    }
    sequence(id, field = 'text') {
        const key = textKey(id, field), record = this.records.get(id), scalar = field === 'text' ? 'text' : 'cells';
        const epoch = record?.[scalar]?.stamp || record?.type?.stamp || [1, 'seed'];
        let seq = this.texts.get(key);
        if (!seq || compareStamp(epoch, seq.epoch) > 0) {
            const [, r, c] = field.split(':');
            const base = field === 'text' ? record?.text?.value || '' : record?.cells?.value?.[+r]?.[+c] || '';
            seq = new RichSequence(base, epoch); this.texts.set(key, seq);
        }
        return seq;
    }
    textEdit(id, nextText, field = 'text', basis = null, marks = {}) {
        const seq = this.sequence(id, field), stamp = [this.clock + 1, this.actor];
        return seq.change(id, field, seq.splice(basis || seq.visible(), String(nextText).slice(0, field === 'text' ? 40000 : 5000), stamp, marks));
    }
    stamp(id, key) { return this.records.get(id)?.[key]?.stamp; }
    all() { if (!this.cached)
        this.cached = [...this.records.keys()].map(id => this.get(id)).filter(o => o && !o.$deleted && o.type); return this.cached; }
    objects() { return this.all().filter(o => !['meta', 'comment', 'chat', 'vote', 'session'].includes(o.type)); }
    make(changes = [], text = []) {
        const clock = ++this.clock, stamp = [clock, this.actor], scalarChanges = [], edits = clone(text);
        let insertionIndex = edits.reduce((n, t) => n + t.actions.filter(a => a.char !== undefined).length, 0);
        for (const c of clone(changes)) {
            const prior = this.get(c.id, true);
            if (prior && (Object.hasOwn(c.props, 'text') || Object.hasOwn(c.props, 'richText'))) {
                const seq = this.sequence(c.id), target = Object.hasOwn(c.props, 'text') ? String(c.props.text || '') : seq.string();
                const actions = seq.splice(seq.visible(), target, stamp, {}, insertionIndex);
                insertionIndex += actions.filter(a => a.char !== undefined).length;
                if (c.props.richText !== undefined && c.props.richText !== null) {
                    validateProps({ richText: c.props.richText });
                    if (c.props.richText.map(r => r.text).join('') !== target) throw Error('Rich text runs must match their text');
                    const staged = RichSequence.from(seq.snapshot()); staged.apply(actions, stamp);
                    const nodes = staged.visible(), byId = new Map(actions.map(a => [a.id, a])); let offset = 0;
                    for (const run of c.props.richText) for (const char of Array.from(run.text)) {
                        const n = nodes[offset++], desired = run.marks || {}, marks = {};
                        for (const key of new Set([...Object.keys(n.marks), ...Object.keys(desired)])) {
                            const value = desired[key] ?? null;
                            if (value !== (n.marks[key]?.value ?? null)) marks[key] = value;
                        }
                        if (Object.keys(marks).length) { let action = byId.get(n.id); if (!action) { action = { id: n.id }; actions.push(action); byId.set(n.id, action); } action.marks = { ...action.marks, ...marks }; }
                    }
                }
                if (actions.length) edits.push(seq.change(c.id, 'text', actions));
                delete c.props.text; delete c.props.richText;
            }
            if (prior && Object.hasOwn(c.props, 'cells') && Array.isArray(c.props.cells)) {
                for (let r = 0; r < c.props.cells.length; r++) for (let col = 0; col < c.props.cells[r].length; col++) {
                    const field = `cell:${r}:${col}`, seq = this.sequence(c.id, field);
                    const actions = seq.splice(seq.visible(), c.props.cells[r][col], stamp, {}, insertionIndex);
                    insertionIndex += actions.filter(a => a.char !== undefined).length;
                    if (actions.length) edits.push(seq.change(c.id, field, actions));
                }
                delete c.props.cells;
            }
            if (Object.keys(c.props).length) scalarChanges.push(c);
        }
        if (!scalarChanges.length && !edits.length) return null;
        const op = { id: uid('op'), actor: this.actor, clock, changes: scalarChanges, ...(edits.length ? { text: edits } : {}) };
        validateOperation(op); return op;
    }
    apply(op, source = 'remote') {
        if (!op) return 0;
        validateOperation(op);
        this.clock = Math.max(this.clock, op.clock);
        const stamp = [op.clock, op.actor], changed = [];
        for (const c of op.changes) {
            let r = this.records.get(c.id);
            if (!r) {
                r = Object.create(null);
                this.records.set(c.id, r);
            }
            let dirty = false;
            for (const [key, value] of Object.entries(c.props)) {
                if (compareStamp(stamp, r[key]?.stamp) > 0) {
                    r[key] = { value: clone(value), stamp: [...stamp] };
                    dirty = true;
                }
            }
            if (c.props.richText && c.props.text !== undefined && compareStamp(stamp, r.text?.stamp) === 0) {
                const seq = this.sequence(c.id), nodes = seq.visible(); let index = 0;
                for (const run of c.props.richText) { const actions = []; for (const char of Array.from(run.text)) { const n = nodes[index++]; if (n) actions.push({ id: n.id, marks: run.marks || {} }); } seq.apply(actions, stamp); }
            }
            if (dirty) changed.push(c.id);
        }
        for (const t of op.text || []) {
            const key = textKey(t.id, t.field), r = this.records.get(t.id), scalarStamp = r?.[t.field === 'text' ? 'text' : 'cells']?.stamp;
            if (scalarStamp && compareStamp(scalarStamp, t.epoch) > 0) continue;
            let seq = this.texts.get(key);
            if (!seq || compareStamp(t.epoch, seq.epoch) > 0) { seq = new RichSequence(t.base, t.epoch); this.texts.set(key, seq); }
            if (compareStamp(t.epoch, seq.epoch) === 0 && seq.apply(t.actions, stamp)) changed.push(t.id);
        }
        if (changed.length) {
            this.revision++;
            this.cached = null;
            for (const fn of this.listeners)
                fn({ op, source, ids: changed });
        }
        return changed.length;
    }
    transact(changes, source = 'local', text = []) { const op = this.make(changes, text); this.apply(op, source); return op; }
    snapshot() { return { format: FORMAT, clock: this.clock, texts: [...this.texts].map(([key, seq]) => ({ key, ...seq.snapshot() })), records: [...this.records].map(([id, fields]) => ({ id, fields: clone(fields) })) }; }
    merge(snapshot, source = 'snapshot') {
        if (![FORMAT, LEGACY_FORMAT].includes(snapshot?.format) || !Array.isArray(snapshot.records) || snapshot.records.length > 100000)
            throw Error('Not an Orivane document');
        // Validate the entire snapshot before changing state (atomic malformed-import rejection).
        const rich = [];
        if (snapshot.texts !== undefined) {
            if (!Array.isArray(snapshot.texts) || snapshot.texts.length > 100000) throw Error('Invalid rich text collection');
            const keys = new Set(); let totalNodes = 0;
            for (const t of snapshot.texts) {
                if (typeof t.key !== 'string' || keys.has(t.key)) throw Error('Invalid text key');
                const [id, field, extra] = t.key.split('/');
                validateTextChange({ id, field, base: t.base, epoch: t.epoch, actions: [] });
                if (extra !== undefined) throw Error('Invalid text key'); keys.add(t.key);
                const seq = RichSequence.from(t); totalNodes += seq.nodes.size;
                if (totalNodes > 1000000) throw Error('Text node capacity exceeded');
                rich.push([t.key, seq]);
            }
        }
        const ops = [], recordIds = new Set();
        for (const record of snapshot.records) {
            if (!record || typeof record !== 'object') throw Error('Invalid record');
            const { id, fields } = record;
            if (recordIds.has(id)) throw Error('Duplicate record'); recordIds.add(id);
            if (!validId(id) || !fields || typeof fields !== 'object' || Array.isArray(fields))
                throw Error('Invalid record');
            const groups = new Map();
            for (const [key, f] of Object.entries(fields)) {
                if (!f || !Array.isArray(f.stamp) || f.stamp.length !== 2)
                    throw Error('Invalid field stamp');
                const k = JSON.stringify(f.stamp);
                let g = groups.get(k);
                if (!g) {
                    g = { id: uid('merge'), actor: f.stamp[1], clock: f.stamp[0], changes: [{ id, props: {} }] };
                    groups.set(k, g);
                }
                Object.defineProperty(g.changes[0].props, key, { value: clone(f.value), enumerable: true });
            }
            for (const op of groups.values()) {
                validateOperation(op);
                ops.push(op);
            }
        }
        const listeners = this.listeners;
        this.listeners = new Set();
        let changed = 0;
        try {
            for (const op of ops) changed += this.apply(op, source);
            for (const [key, seq] of rich) {
                const own = this.texts.get(key);
                if (!own || compareStamp(seq.epoch, own.epoch) > 0) { this.texts.set(key, seq); changed++; }
                else if (compareStamp(seq.epoch, own.epoch) === 0 && own.merge(seq)) changed++;
            }
            for (const [, s] of rich) { this.clock = Math.max(this.clock, s.epoch[0]); for (const n of s.nodes.values()) { this.clock = Math.max(this.clock, Number(n.id.split('|')[0]), n.deleted?.stamp?.[0] || 0); for (const f of Object.values(n.marks || {})) this.clock = Math.max(this.clock, f.stamp[0]); } }
            if (changed) { this.cached = null; this.revision++; }
        }
        finally {
            this.listeners = listeners;
        }
        if (changed) {
            for (const fn of listeners)
                fn({ source, op: null, ids: [...this.records.keys()] });
        }
        return changed;
    }
    canonical() {
        const snap = this.snapshot();
        return JSON.stringify({ records: snap.records.sort((a, b) => a.id.localeCompare(b.id)).map(r => ({ id: r.id, fields: Object.fromEntries(Object.entries(r.fields).sort(([a], [b]) => a.localeCompare(b))) })), texts: snap.texts.sort((a, b) => a.key.localeCompare(b.key)).map(t => ({ ...t, nodes: t.nodes.sort((a, b) => a.id.localeCompare(b.id)).map(n => ({ id: n.id, left: n.left, char: n.char, deleted: n.deleted, marks: Object.fromEntries(Object.entries(n.marks).sort(([a], [b]) => a.localeCompare(b))) })) })) });
    }
}
export function makeObject(type, x, y, props = {}) {
    return { id: uid(type), type, x, y, w: type === 'sticky' ? 170 : 200, h: type === 'sticky' ? 170 : 100, z: Date.now(), text: type === 'sticky' ? 'Your next big idea' : type === 'text' ? 'Add your text' : type === 'card' ? 'New task' : '', fill: type === 'sticky' ? '#fff0a6' : type === 'text' ? 'transparent' : '#ffffff', stroke: type === 'sticky' || type === 'text' ? 'transparent' : '#9ca3b8', strokeWidth: 1.5, fontSize: type === 'text' ? 26 : 18, fontFamily: 'sans-serif', align: type === 'sticky' ? 'center' : 'left', rotation: 0, opacity: 1, radius: type === 'rect' || type === 'card' ? 10 : 0, $deleted: false, ...props };
}
