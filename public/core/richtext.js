/** Character-level replicated growable array (RGA).
 * Immutable insertion identities and anchors; independently stamped deletion and
 * mark registers. Unseen parents/characters are retained, so any delivery order,
 * including delete-before-insert, converges. Tree traversal is iterative.
 * No DOM, network or third-party dependencies.
 */
const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link', 'color', 'highlight', 'list']);
const cmp = (a, b) => !b ? 1 : a[0] - b[0] || (a[1] === b[1] ? 0 : a[1] > b[1] ? 1 : -1);
const cp = value => structuredClone(value);
export const textKey = (id, field = 'text') => `${id}/${field}`;
export function safeLink(value) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid link');
    let u; try { u = new URL(value); } catch { throw Error('Links need an absolute URL'); }
    if (!['https:', 'http:', 'mailto:'].includes(u.protocol) || u.username || u.password) throw Error('Unsafe link scheme');
    return u.href;
}
export function validateMarks(marks) {
    if (!marks || typeof marks !== 'object' || Array.isArray(marks) || Object.keys(marks).length > MARKS.size) throw Error('Invalid text marks');
    for (const [k, v] of Object.entries(marks)) {
        if (!MARKS.has(k)) throw Error(`Unknown text mark: ${k}`);
        if (v === null) continue;
        if (k === 'link') safeLink(v);
        else if (k === 'color' || k === 'highlight') { if (!/^#[0-9a-f]{6}$/i.test(v)) throw Error('Invalid text color'); }
        else if (k === 'list') { if (!['bullet', 'number'].includes(v)) throw Error('Invalid list mark'); }
        else if (typeof v !== 'boolean') throw Error('Invalid text mark value');
    }
}
// Fixed-length counter/index components make lexicographic ordering portable.
export const atomId = (stamp, index) => `${String(stamp[0]).padStart(13, '0')}|${stamp[1]}|${String(index).padStart(6, '0')}`;
const atomPattern = /^\d{13}\|[a-zA-Z0-9_:@.\-]{1,180}\|\d{6}$/;
const validActor = a => typeof a === 'string' && /^[a-zA-Z0-9_:@.\-]{1,180}$/.test(a) && !['__proto__', 'constructor', 'prototype'].includes(a);
export const validAtom = id => typeof id === 'string' && atomPattern.test(id) && +id.slice(0, 13) <= 1e12 && validActor(id.split('|')[1]);
const atomParts = id => { const [n, a, i] = id.split('|'); return [+n, a, +i]; };
function earlier(a, b) { const x = atomParts(a), y = atomParts(b); return x[0] < y[0] || (x[0] === y[0] && x[1] === y[1] && x[2] < y[2]); }
export function validateTextChange(change, stamp) {
    if (!change || typeof change.id !== 'string' || !/^[a-zA-Z0-9_:@.\-]{1,180}$/.test(change.id) || ['__proto__', 'constructor', 'prototype'].includes(change.id)) throw Error('Invalid text object');
    if (!/^(text|cell:(?:[0-9]|[1-9][0-9]):(?:[0-9]|[12][0-9]))$/.test(change.field)) throw Error('Invalid text field');
    if (!Array.isArray(change.epoch) || change.epoch.length !== 2 || !Number.isSafeInteger(change.epoch[0]) || change.epoch[0] < 1 || change.epoch[0] > 1e12 || !validActor(change.epoch[1])) throw Error('Invalid text epoch');
    if (stamp && cmp(change.epoch, stamp) > 0) throw Error('Text generation is newer than the operation');
    if (typeof change.base !== 'string' || change.base.length > 40000) throw Error('Invalid text base');
    if (!Array.isArray(change.actions) || change.actions.length > 80000) throw Error('Invalid text actions');
    const seen = new Set();
    for (const a of change.actions) {
        if (!a || !validAtom(a.id) || seen.has(a.id)) throw Error('Invalid or duplicate character');
        seen.add(a.id);
        if (Object.keys(a).some(k => !['id', 'left', 'char', 'deleted', 'marks'].includes(k))) throw Error('Unknown character property');
        if (a.char !== undefined) {
            if (typeof a.char !== 'string' || Array.from(a.char).length !== 1 || a.char.length > 2) throw Error('Character must be one Unicode code point');
            if (a.left !== '' && !validAtom(a.left)) throw Error('Invalid insertion anchor');
            if (a.left && !earlier(a.left, a.id)) throw Error('Cyclic or non-causal character anchor');
            const [clock, actor] = atomParts(a.id);
            if (stamp && (clock !== stamp[0] || actor !== stamp[1])) throw Error('Character identity must match its operation');
        } else if (a.left !== undefined) throw Error('Anchor without character');
        if (a.deleted !== undefined && typeof a.deleted !== 'boolean') throw Error('Invalid character tombstone');
        if (a.marks !== undefined) validateMarks(a.marks);
    }
    return true;
}
export class RichSequence {
    constructor(base = '', epoch = [1, 'seed']) {
        this.base = base; this.epoch = [...epoch]; this.nodes = new Map(); this.revision = 0; this.cache = null;
        // Seed IDs use clock zero; the sequence epoch separates legacy resets.
        let left = '', i = 0;
        for (const char of Array.from(base)) { const id = atomId([0, 'seed'], i++); this.nodes.set(id, { id, left, char, deleted: { value: false, stamp: [0, 'seed'] }, marks: {} }); left = id; }
    }
    apply(actions, stamp) {
        let dirty = false;
        for (const a of actions) {
            let n = this.nodes.get(a.id);
            if (!n) { n = { id: a.id, marks: {} }; this.nodes.set(a.id, n); }
            if (a.char !== undefined && n.char === undefined) { n.char = a.char; n.left = a.left; dirty = true; }
            // An insertion implies undeleted at the insertion stamp, not at replay time.
            if (a.char !== undefined && !n.deleted) { n.deleted = { value: false, stamp: [...stamp] }; dirty = true; }
            if (a.deleted !== undefined && cmp(stamp, n.deleted?.stamp) > 0) { n.deleted = { value: a.deleted, stamp: [...stamp] }; dirty = true; }
            for (const [k, v] of Object.entries(a.marks || {})) if (cmp(stamp, n.marks[k]?.stamp) > 0) { n.marks[k] = { value: v, stamp: [...stamp] }; dirty = true; }
        }
        if (dirty) { this.revision++; this.cache = null; }
        return dirty;
    }
    ordered() {
        if (this.cache) return this.cache;
        const children = new Map();
        for (const n of this.nodes.values()) if (n.char !== undefined) { const group = children.get(n.left) || []; group.push(n); children.set(n.left, group); }
        for (const list of children.values()) list.sort((a, b) => a.id === b.id ? 0 : a.id > b.id ? -1 : 1);
        const out = [], stack = (children.get('') || []).slice().reverse();
        while (stack.length) { const n = stack.pop(); out.push(n); const list = children.get(n.id); if (list) for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]); }
        this.cache = out;
        return out;
    }
    visible() { return this.ordered().filter(n => !n.deleted?.value); }
    string() { return this.visible().map(n => n.char).join(''); }
    runs() {
        const runs = []; let last = null;
        for (const n of this.visible()) {
            const marks = Object.fromEntries(Object.entries(n.marks).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.value]).filter(([, v]) => v !== null));
            const key = JSON.stringify(marks);
            if (last && last.key === key) last.text += n.char;
            else { last = { key, text: n.char, marks }; runs.push(last); }
        }
        return runs.map(({ text, marks }) => ({ text, marks }));
    }
    /** Return actions relative to the editor's last displayed character IDs.
     * This also preserves remote inserts received during an IME composition.
     */
    splice(beforeNodes, nextText, stamp, marks = {}, startIndex = 0) {
        const old = beforeNodes.map(n => n.char), next = Array.from(nextText); let prefix = 0, suffix = 0;
        while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
        while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
        const actions = beforeNodes.slice(prefix, old.length - suffix).map(n => ({ id: n.id, deleted: true }));
        let left = beforeNodes[prefix - 1]?.id || '';
        for (let i = prefix; i < next.length - suffix; i++) { const id = atomId(stamp, startIndex++); actions.push({ id, left, char: next[i], marks: cp(marks) }); left = id; }
        return actions;
    }
    change(id, field, actions) { return { id, field, base: this.base, epoch: [...this.epoch], actions }; }
    snapshot() { return { base: this.base, epoch: [...this.epoch], nodes: [...this.nodes.values()].map(cp) }; }
    static from(snapshot) {
        if (!snapshot || typeof snapshot.base !== 'string' || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > 250000) throw Error('Invalid rich text snapshot');
        validateTextChange({ id: 'validate', field: 'text', base: snapshot.base, epoch: snapshot.epoch, actions: [] });
        const s = new RichSequence(snapshot.base, snapshot.epoch);
        const seen = new Set();
        for (const n of snapshot.nodes) {
            if (!n || !validAtom(n.id) || seen.has(n.id) || Object.keys(n).some(k => !['id', 'left', 'char', 'deleted', 'marks'].includes(k))) throw Error('Invalid rich text node'); seen.add(n.id);
            if (n.marks !== undefined && (!n.marks || typeof n.marks !== 'object' || Array.isArray(n.marks))) throw Error('Invalid character marks');
            if (n.char === undefined && n.left !== undefined) throw Error('Anchor without character');
            if (n.char !== undefined) {
                if (atomParts(n.id)[0] === 0) { const seed = s.nodes.get(n.id); if (!seed || seed.char !== n.char || seed.left !== n.left) throw Error('Invalid seed character'); }
                else validateTextChange({ id: 'validate', field: 'text', base: '', epoch: snapshot.epoch, actions: [{ id: n.id, char: n.char, left: n.left }] });
            }
            const registers = Object.entries(n.marks || {});
            if (n.deleted) registers.push(['deleted', n.deleted]);
            for (const [k, f] of registers) {
                if (!f || !Array.isArray(f.stamp) || f.stamp.length !== 2 || !Number.isSafeInteger(f.stamp[0]) || f.stamp[0] < 0 || f.stamp[0] > 1e12 || !validActor(f.stamp[1])) throw Error('Invalid character register');
                if (k === 'deleted') { if (typeof f.value !== 'boolean') throw Error('Invalid tombstone'); }
                else validateMarks({ [k]: f.value });
            }
            s.nodes.set(n.id, { ...cp(n), marks: cp(n.marks || {}) });
        }
        s.cache = null;
        return s;
    }
    merge(other) {
        let dirty = false;
        for (const n of other.nodes.values()) {
            let own = this.nodes.get(n.id);
            if (!own) { this.nodes.set(n.id, { ...cp(n), marks: cp(n.marks || {}) }); dirty = true; continue; }
            if (n.char !== undefined && own.char === undefined) { own.char = n.char; own.left = n.left; dirty = true; }
            if (n.deleted && cmp(n.deleted.stamp, own.deleted?.stamp) > 0) { own.deleted = cp(n.deleted); dirty = true; }
            for (const [k, f] of Object.entries(n.marks || {})) if (cmp(f.stamp, own.marks[k]?.stamp) > 0) { own.marks[k] = cp(f); dirty = true; }
        }
        if (dirty) { this.cache = null; this.revision++; }
        return dirty;
    }
}
