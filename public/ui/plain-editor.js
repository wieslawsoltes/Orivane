/** Live RGA binding for table cells and task descriptions. Plain form controls
 * keep browser accessibility and IME support without replacing remote strings.
 * Caller must dispose before removing the control. */
export function bindPlainEditor(app, id, field, input) {
    const doc = app.doc; let basis = doc.sequence(id, field).visible(), composing = false, applying = false;
    const anchor = at => ({ left: basis[at - 1]?.id, right: basis[at]?.id });
    const render = () => {
        const a = anchor(Array.from(input.value.slice(0, input.selectionStart || 0)).length), b = anchor(Array.from(input.value.slice(0, input.selectionEnd || 0)).length), focused = document.activeElement === input;
        basis = doc.sequence(id, field).visible(); input.value = basis.map(n => n.char).join('');
        const locate = p => { let at = basis.findIndex(n => n.id === p.right); if (at < 0) { at = basis.findIndex(n => n.id === p.left); at = at < 0 ? 0 : at + 1; } return basis.slice(0, at).map(n => n.char).join('').length; };
        if (focused) input.setSelectionRange(locate(a), locate(b));
    };
    const commit = () => {
        if (composing || !app.writable || doc.get(id)?.locked) return;
        const a = input.selectionStart, b = input.selectionEnd; applying = true;
        try { const change = doc.textEdit(id, input.value, field, basis); if (change.actions.length) app.history.executeText(change, field === 'text' ? 'Edit task text' : 'Edit table cell'); }
        catch (e) { app.toast(e.message); }
        finally { applying = false; }
        basis = doc.sequence(id, field).visible(); input.value = basis.map(n => n.char).join(''); input.setSelectionRange(a, b); app.invalidate();
    };
    input.addEventListener('input', commit);
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; commit(); });
    input.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); app.history[e.shiftKey ? 'redo' : 'undo'](); } });
    const unsub = doc.onChange(event => { if (!applying && !composing && event.ids.includes(id)) { if (!doc.get(id)) { input.disabled = true; return; } render(); } });
    render(); return () => { if (composing) { composing = false; commit(); } unsub(); input.removeEventListener('input', commit); };
}
