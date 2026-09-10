import { clone, compareStamp } from './model.js';
/** Selective compensating history for both object registers and character IDs.
 * Undo never restores a stale whole string over another author's contribution.
 */
export class History {
    constructor(doc, limit = 150) { this.doc = doc; this.limit = limit; this.undoStack = []; this.redoStack = []; }
    execute(changes, label = 'Edit', text = []) {
        const op = this.doc.make(changes, text); if (!op) return null;
        const created = new Set();
        const reverse = op.changes.map(c => {
            const old = this.doc.get(c.id, true); if (!old) created.add(c.id);
            return { id: c.id, props: old ? Object.fromEntries(Object.keys(c.props).map(k => [k, old[k] ?? null])) : { $deleted: true } };
        });
        const reverseText = [], forwardText = [];
        for (const t of op.text || []) {
            const seq = this.doc.sequence(t.id, t.field), back = [], forward = [];
            for (const a of t.actions) {
                const n = seq.nodes.get(a.id), undo = { id: a.id }, redo = { id: a.id };
                if (a.char !== undefined) { undo.deleted = true; redo.deleted = false; }
                else if (a.deleted !== undefined) { undo.deleted = n?.deleted?.value || false; redo.deleted = a.deleted; }
                if (a.marks && a.char === undefined) {
                    undo.marks = Object.fromEntries(Object.keys(a.marks).map(k => [k, n?.marks?.[k]?.value ?? null]));
                    redo.marks = clone(a.marks);
                }
                back.push(undo); forward.push(redo);
            }
            reverseText.push({ ...clone(t), actions: back }); forwardText.push({ ...clone(t), actions: forward });
        }
        this.doc.apply(op, 'local');
        this.undoStack.push({ label, reverse, forward: clone(op.changes).map(c => created.has(c.id) ? { id: c.id, props: { ...c.props, $deleted: false } } : c), reverseText, forwardText, stamp: [op.clock, op.actor] });
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack = [];
        return op;
    }
    executeText(change, label = 'Edit text') { return this.execute([], label, [change]); }
    applyEntry(from, to, direction) {
        const entry = from.pop(); if (!entry) return false;
        const target = direction === 'undo' ? entry.reverse : entry.forward;
        const changes = target.map(c => ({ id: c.id, props: Object.fromEntries(Object.entries(c.props).filter(([key]) => {
            const stamp = this.doc.stamp(c.id, key);
            if (key === '$deleted' && (!stamp || direction === 'undo' && c.props[key] === true))
                { // Do not remove an object that received another author's later changes.
                    const remoteLater = stamp => stamp && stamp[1] !== this.doc.actor && compareStamp(stamp, entry.stamp) > 0;
                    if (Object.values(this.doc.records.get(c.id) || {}).some(f => remoteLater(f.stamp))) return false;
                    for (const [key, seq] of this.doc.texts) if (key.startsWith(c.id + '/')) for (const n of seq.nodes.values()) {
                        const [clock, actor] = n.id.split('|');
                        if (remoteLater([+clock, actor]) || remoteLater(n.deleted?.stamp) || Object.values(n.marks).some(f => remoteLater(f.stamp))) return false;
                    }
                    return true;
                }
            return stamp && compareStamp(stamp, entry.stamp) === 0;
        })) })).filter(c => Object.keys(c.props).length);
        const text = [], appliedText = new Map();
        for (const t of (direction === 'undo' ? entry.reverseText : entry.forwardText) || []) {
            const seq = this.doc.sequence(t.id, t.field); if (compareStamp(seq.epoch, t.epoch) !== 0) continue;
            const actions = [];
            const superseded = direction === 'undo' && t.actions.some(a => a.deleted === true && seq.nodes.get(a.id)?.deleted?.value === true && compareStamp(seq.nodes.get(a.id).deleted.stamp, entry.stamp) > 0);
            for (const a of t.actions) {
                const n = seq.nodes.get(a.id); if (!n) continue;
                const out = { id: a.id }, keys = new Set();
                if (a.deleted !== undefined && !(superseded && a.deleted === false) && n.deleted && compareStamp(n.deleted.stamp, entry.stamp) === 0) { out.deleted = a.deleted; keys.add('deleted'); }
                for (const [k, v] of Object.entries(a.marks || {})) if (n.marks[k] && compareStamp(n.marks[k].stamp, entry.stamp) === 0) { (out.marks ||= {})[k] = v; keys.add(k); }
                if (keys.size) { actions.push(out); appliedText.set(`${t.id}/${t.field}/${a.id}`, keys); }
            }
            if (actions.length) text.push({ ...t, actions });
        }
        if (!changes.length && !text.length) return false;
        // Undo scalar creation is kept scalar. Text restoration uses ID actions.
        const op = this.doc.make(changes, text); this.doc.apply(op, 'local');
        const applied = new Map(changes.map(c => [c.id, new Set(Object.keys(c.props))]));
        const other = direction === 'undo' ? entry.forward : entry.reverse;
        const filtered = other.map(c => ({ id: c.id, props: Object.fromEntries(Object.entries(c.props).filter(([k]) => applied.get(c.id)?.has(k))) })).filter(c => Object.keys(c.props).length);
        const otherText = (direction === 'undo' ? entry.forwardText : entry.reverseText) || [];
        const filteredText = otherText.map(t => ({ ...t, actions: t.actions.map(a => {
            const keys = appliedText.get(`${t.id}/${t.field}/${a.id}`), out = { id: a.id };
            if (!keys) return null;
            if (keys.has('deleted')) out.deleted = a.deleted;
            for (const [k, v] of Object.entries(a.marks || {})) if (keys.has(k)) (out.marks ||= {})[k] = v;
            return out;
        }).filter(Boolean) })).filter(t => t.actions.length);
        const next = { ...entry, stamp: [op.clock, op.actor] };
        if (direction === 'undo') { next.forward = filtered; next.forwardText = filteredText; }
        else { next.reverse = filtered; next.reverseText = filteredText; }
        to.push(next); return true;
    }
    undo() { return this.applyEntry(this.undoStack, this.redoStack, 'undo'); }
    redo() { return this.applyEntry(this.redoStack, this.undoStack, 'redo'); }
}
