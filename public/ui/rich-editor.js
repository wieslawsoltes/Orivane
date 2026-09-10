import { safeLink } from '../core/richtext.js';
/** A DOM input surface, never the source of document authority. All mutations
 * become ID-based text operations immediately. Rendering uses safe text nodes.
 */
export function domText(root) {
    let text = '';
    const visit = node => {
        if (node.nodeType === 3) { text += node.nodeValue; return; }
        if (node.nodeName === 'BR') { text += '\n'; return; }
        const block = ['DIV', 'P', 'LI'].includes(node.nodeName);
        if (block && node !== root && text && !text.endsWith('\n')) text += '\n';
        for (const c of node.childNodes) visit(c);
    };
    visit(root); return text.replace(/\r/g, '');
}
function offsets(root) {
    const s = getSelection(); if (!s?.rangeCount || !root.contains(s.anchorNode) || !root.contains(s.focusNode)) return null;
    const lengthTo = (node, at) => { const r = document.createRange(); r.selectNodeContents(root); r.setEnd(node, at); return Array.from(domText(r.cloneContents())).length; };
    return { anchor: lengthTo(s.anchorNode, s.anchorOffset), focus: lengthTo(s.focusNode, s.focusOffset) };
}
function setOffsets(root, anchor, focus = anchor) {
    const locate = index => {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node, last;
        while ((node = w.nextNode())) { const chars = Array.from(node.data); if (index <= chars.length) return [node, chars.slice(0, index).join('').length]; index -= chars.length; last = node; }
        return last ? [last, last.data.length] : [root, 0];
    };
    const a = locate(Math.max(0, anchor)), f = locate(Math.max(0, focus)); getSelection()?.setBaseAndExtent(...a, ...f);
}
export class RichTextEditor {
    constructor(controller, object, area) {
        this.controller = controller; this.app = controller.app; this.doc = controller.doc; this.object = object; this.area = area; this.field = 'text'; this.pending = {}; this.composing = false;
        area.contentEditable = 'true'; area.role = 'textbox'; area.setAttribute('aria-multiline', 'true'); area.spellcheck = true;
        // Keep the ordinary value contract useful for test drivers and extensions.
        Object.defineProperty(area, 'value', { get: () => domText(area), set: value => { area.textContent = value; } });
        this.render(false);
        this.toolbar = document.createElement('div'); this.toolbar.className = 'rich-toolbar'; this.toolbar.setAttribute('role', 'toolbar'); this.toolbar.setAttribute('aria-label', 'Text formatting');
        for (const [key, label, glyph] of [['bold','Bold','B'],['italic','Italic','I'],['underline','Underline','U'],['strike','Strikethrough','S'],['code','Code','‹›'],['link','Hyperlink','↗'],['bullet','Bulleted list','•'],['number','Numbered list','1.']]) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = glyph; b.title = label; b.setAttribute('aria-label', label); b.dataset.mark = key;
            b.addEventListener('pointerdown', e => e.preventDefault()); b.onclick = () => this.format(key); this.toolbar.append(b);
        }
        const color = document.createElement('input'); color.type = 'color'; color.value = '#25283d'; color.title = 'Text color'; color.setAttribute('aria-label', 'Text color');
        color.onpointerdown = () => this.savedSelection = this.capture(); color.oninput = () => { this.restore(this.savedSelection); this.format('color', color.value); }; this.toolbar.append(color);
        document.getElementById('text-edit-layer').append(this.toolbar); this.position();
        area.addEventListener('input', () => { if (!this.composing) this.commitInput(); });
        area.addEventListener('compositionstart', () => { this.composing = true; });
        area.addEventListener('compositionend', () => { this.composing = false; this.commitInput(); });
        area.addEventListener('beforeinput', e => {
            if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); this.app.history[e.inputType === 'historyUndo' ? 'undo' : 'redo'](); this.render(); }
            if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') { e.preventDefault(); this.insert('\n'); }
        });
        area.addEventListener('paste', e => { e.preventDefault(); this.insert(e.clipboardData.getData('text/plain')); });
        area.addEventListener('keydown', e => {
            e.stopPropagation(); const mod = e.ctrlKey || e.metaKey;
            if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) { e.preventDefault(); this.format({ b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()]); }
            else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); this.app.history[e.shiftKey ? 'redo' : 'undo'](); this.render(); }
            else if (e.key === 'Escape' || e.key === 'Tab' || mod && e.key === 'Enter') { e.preventDefault(); controller.endText(); }
        });
        area.addEventListener('blur', e => { if (!this.toolbar.contains(e.relatedTarget)) setTimeout(() => { if (!this.toolbar.contains(document.activeElement) && document.activeElement !== area) controller.endText(); }, 0); });
        this.unsub = this.doc.onChange(e => { if (!e.ids.includes(object.id) || this.applying || this.composing) return; if (!this.doc.get(object.id)) return controller.endText(false); this.render(); });
        area.focus(); setOffsets(area, 0, this.basis.length);
    }
    position() { this.toolbar.style.left = `${Math.max(10, parseFloat(this.area.style.left))}px`; this.toolbar.style.top = `${Math.max(68, parseFloat(this.area.style.top) - 45)}px`; }
    capture() {
        const p = offsets(this.area); if (!p) return null;
        const anchor = index => ({ left: this.basis[index - 1]?.id || '', right: this.basis[index]?.id || '' });
        return { anchor: anchor(p.anchor), focus: anchor(p.focus) };
    }
    restore(selection) {
        if (!selection) return; const list = this.doc.sequence(this.object.id).visible();
        const locate = pos => { if (pos.right) { const at = list.findIndex(n => n.id === pos.right); if (at >= 0) return at; } if (pos.left) { const at = list.findIndex(n => n.id === pos.left); if (at >= 0) return at + 1; } return 0; };
        setOffsets(this.area, locate(selection.anchor), locate(selection.focus));
    }
    render(preserve = true) {
        const selection = preserve ? this.capture() : null, seq = this.doc.sequence(this.object.id);
        this.basis = seq.visible().map(n => ({ id: n.id, char: n.char }));
        const frag = document.createDocumentFragment();
        for (const run of seq.runs()) {
            const span = document.createElement(run.marks.link ? 'a' : 'span'), m = run.marks;
            span.textContent = run.text;
            if (m.bold !== undefined) span.style.fontWeight = m.bold ? '700' : '400';
            if (m.italic !== undefined) span.style.fontStyle = m.italic ? 'italic' : 'normal';
            span.style.textDecoration = [m.underline || m.link ? 'underline' : '', m.strike ? 'line-through' : ''].filter(Boolean).join(' ');
            if (m.code) { span.style.fontFamily = 'monospace'; span.style.background = '#e9e5f2'; }
            if (m.color) span.style.color = m.color;
            if (m.highlight) span.style.background = m.highlight;
            if (m.link) { span.href = safeLink(m.link); span.rel = 'noopener noreferrer'; span.target = '_blank'; span.onclick = e => { if (!(e.ctrlKey || e.metaKey)) e.preventDefault(); }; }
            frag.append(span);
        }
        if (!frag.childNodes.length) frag.append(document.createTextNode(''));
        this.area.replaceChildren(frag); this.restore(selection);
    }
    commitInput() {
        if (!this.controller.canEdit()) return this.render();
        const p = offsets(this.area), value = domText(this.area).slice(0, 40000), next = Array.from(value);
        let prefix = 0; while (prefix < this.basis.length && prefix < next.length && this.basis[prefix].char === next[prefix]) prefix++;
        const inherited = this.inheritedMarks(prefix), change = this.doc.textEdit(this.object.id, value, 'text', this.basis, { ...inherited, ...this.pending });
        this.applying = true;
        try { if (change.actions.length) this.app.history.executeText(change); }
        catch (e) { this.app.toast(e.message); }
        finally { this.applying = false; }
        this.render(false); if (p) setOffsets(this.area, p.anchor, p.focus);
        this.app.invalidate();
    }
    insert(text) {
        const p = offsets(this.area) || { anchor: this.basis.length, focus: this.basis.length }, chars = Array.from(domText(this.area));
        const start = Math.min(p.anchor, p.focus), end = Math.max(p.anchor, p.focus), insertion = Array.from(text);
        chars.splice(start, end - start, ...insertion); this.area.textContent = chars.join(''); setOffsets(this.area, start + insertion.length); this.commitInput();
    }
    inheritedMarks(index) {
        const seq = this.doc.sequence(this.object.id), id = this.basis[Math.max(0, index - 1)]?.id;
        return Object.fromEntries(Object.entries(seq.nodes.get(id)?.marks || {}).map(([k, f]) => [k, f.value]));
    }
    format(key, value) {
        const p = offsets(this.area) || { anchor: 0, focus: this.basis.length };
        if (key === 'bullet' || key === 'number') {
            const chars = Array.from(domText(this.area)), start = chars.lastIndexOf('\n', Math.max(0, Math.min(p.anchor, p.focus) - 1)) + 1;
            let end = chars.indexOf('\n', Math.max(p.anchor, p.focus)); if (end < 0) end = chars.length;
            const lines = chars.slice(start, end).join('').split('\n').map((line, i) => key === 'bullet' ? `• ${line.replace(/^(• |\d+\. )/, '')}` : `${i + 1}. ${line.replace(/^(• |\d+\. )/, '')}`);
            setOffsets(this.area, start, end); return this.insert(lines.join('\n'));
        }
        if (key === 'link' && value === undefined) {
            const selection = this.capture();
            const input = document.createElement('input'); input.type = 'url'; input.placeholder = 'https://example.com'; input.setAttribute('aria-label', 'Hyperlink URL');
            const apply = document.createElement('button'); apply.textContent = 'Apply link'; const clear = document.createElement('button'); clear.textContent = 'Remove';
            this.toolbar.append(input, apply, clear); input.focus();
            const finish = url => { try { const link = safeLink(url); this.area.focus(); this.restore(selection); this.format('link', link); input.remove(); apply.remove(); clear.remove(); } catch (e) { this.app.toast(e.message); } };
            apply.onpointerdown = e => e.preventDefault(); clear.onpointerdown = e => e.preventDefault(); apply.onclick = () => finish(input.value); clear.onclick = () => finish(null); input.onkeydown = e => { if (e.key === 'Enter') finish(input.value); }; return;
        }
        const seq = this.doc.sequence(this.object.id), selected = seq.visible().slice(Math.min(p.anchor, p.focus), Math.max(p.anchor, p.focus));
        if (value === undefined) value = selected.length ? !selected.every(n => (n.marks[key]?.value ?? this.object[key]) === true) : !(this.pending[key] ?? this.inheritedMarks(p.anchor)[key] ?? this.object[key] ?? false);
        if (!selected.length) { this.pending[key] = value; return; }
        const change = seq.change(this.object.id, 'text', selected.map(n => ({ id: n.id, marks: { [key]: value } })));
        this.app.history.executeText(change, 'Format text'); this.render(); this.area.focus(); setOffsets(this.area, p.anchor, p.focus);
    }
    destroy(commit = true) { if (commit && this.composing) { this.composing = false; this.commitInput(); } this.unsub?.(); this.toolbar.remove(); }
}
