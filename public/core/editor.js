import { RichTextEditor } from '../ui/rich-editor.js';
import { makeObject, uid, clone } from './model.js';
import { bounds, unionBounds, contains, intersects, hitObject, rotatePoint, connectorPoints, clamp, pointSegment } from './geometry.js';
const handleCoords = [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]];
export class EditorController {
    constructor(app) {
        this.app = app;
        this.canvas = app.renderer.overlay;
        this.pointers = new Map();
        this.drag = null;
        this.space = false;
        this.clipboard = [];
        this.lastPoint = { x: 300, y: 300 };
        this.abort = new AbortController();
        const opt = { signal: this.abort.signal };
        this.canvas.addEventListener('pointerdown', e => this.down(e), opt);
        this.canvas.addEventListener('pointermove', e => this.move(e), opt);
        this.canvas.addEventListener('pointerup', e => this.up(e), opt);
        this.canvas.addEventListener('pointercancel', e => this.cancel(e), opt);
        this.canvas.addEventListener('dblclick', e => this.doubleClick(e), opt);
        this.canvas.addEventListener('contextmenu', e => { e.preventDefault(); const p = this.point(e), o = this.hit(p); if (o && !app.state.selection.has(o.id))
            this.select([o.id]); app.contextMenu(e.clientX, e.clientY); }, opt);
        this.canvas.addEventListener('wheel', e => this.wheel(e), { ...opt, passive: false });
        window.addEventListener('keydown', e => this.key(e), opt);
        window.addEventListener('keyup', e => { if (e.code === 'Space') {
            this.space = false;
            this.updateCursor();
        } }, opt);
        window.addEventListener('blur', () => { this.space = false; this.cancel(); }, opt);
        window.addEventListener('paste', e => this.pasteEvent(e), opt);
        window.addEventListener('copy', e => { if (this.isTyping(e.target) || app.modalOpen)
            return; if (app.state.selection.size) {
            e.preventDefault();
            e.clipboardData.setData('text/plain', this.copy(false));
        } }, opt);
        window.addEventListener('cut', e => { if (this.isTyping(e.target) || app.modalOpen)
            return; if (app.state.selection.size) {
            e.preventDefault();
            e.clipboardData.setData('text/plain', this.copy(false));
            this.remove();
        } }, opt);
        const viewport = document.getElementById('viewport');
        viewport.addEventListener('dragover', e => { e.preventDefault(); }, opt);
        viewport.addEventListener('drop', e => { e.preventDefault(); this.lastPoint = this.point(e); app.importFiles([...e.dataTransfer.files], this.lastPoint); }, opt);
    }
    get state() { return this.app.state; }
    get doc() { return this.app.doc; }
    get camera() { return this.app.camera; }
    get tool() { return this.state.tool; }
    get writable() { return this.app.writable; }
    point(e) { const r = this.canvas.getBoundingClientRect(); return this.camera.world({ x: e.clientX - r.left, y: e.clientY - r.top }); }
    screenPoint(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    isTyping(el) { return el?.closest?.('input,textarea,select,[contenteditable="true"]'); }
    hit(p, exclude = []) { this.app.renderer.rebuild(); const ids = this.app.renderer.index.query({ x: p.x - 12 / this.camera.zoom, y: p.y - 12 / this.camera.zoom, w: 24 / this.camera.zoom, h: 24 / this.camera.zoom }); return this.app.renderer.sorted.slice().reverse().find(o => ids.has(o.id) && !exclude.includes(o.id) && hitObject(o, p, 6 / this.camera.zoom, id => this.doc.get(id))); }
    select(ids) { this.state.selection = new Set(ids.filter(id => this.doc.get(id))); this.app.selectionChanged(); this.app.collab?.presence({ selection: [...this.state.selection] }); this.app.invalidate(); }
    chosen() { return [...this.state.selection].map(id => this.doc.get(id)).filter(Boolean); }
    setTool(tool) { this.endText(); this.state.tool = tool; this.state.preview.clear(); this.drag = null; this.app.closePopup(); this.app.updateToolbar(); this.updateCursor(); this.app.invalidate(); }
    updateCursor() { this.canvas.style.cursor = this.space || this.tool === 'hand' ? 'grab' : ['select'].includes(this.tool) ? 'default' : this.tool === 'text' ? 'text' : 'crosshair'; }
    canEdit() { if (this.writable)
        return true; this.app.toast('This board is view-only. Ask the owner for an editor link.'); return false; }
    findHandle(p) {
        const chosen = this.chosen();
        if (chosen.length === 1 && chosen[0].type === 'connector' && !chosen[0].locked) {
            const o = chosen[0], points = connectorPoints(o, id => this.doc.get(id));
            for (const [endpoint, point] of [['from', points[0]], ['to', points.at(-1)]])
                if (Math.hypot(p.x - point.x, p.y - point.y) < 10 / this.camera.zoom)
                    return { mode: 'endpoint', endpoint, object: clone(o), fixed: endpoint === 'from' ? points.at(-1) : points[0], center: point };
            return null;
        }
        if (!chosen.length || chosen.some(o => o.locked || ['connector', 'pen'].includes(o.type)))
            return null;
        const single = chosen.length === 1, o = single ? chosen[0] : unionBounds(chosen), angle = single ? (o.rotation || 0) : 0, center = { x: o.x + o.w / 2, y: o.y + o.h / 2 }, local = rotatePoint(p, center, -angle), tol = 10 / this.camera.zoom;
        if (single && Math.hypot(local.x - (o.x + o.w / 2), local.y - (o.y - 28 / this.camera.zoom)) < tol)
            return { mode: 'rotate', box: o, angle, center };
        for (let i = 0; i < handleCoords.length; i++) {
            const [x, y] = handleCoords[i];
            if (Math.hypot(local.x - (o.x + o.w * x), local.y - (o.y + o.h * y)) < tol)
                return { mode: 'resize', box: clone(o), index: i, angle, center };
        }
        return null;
    }
    related(objects) { const ids = new Set(objects.map(o => o.id)); for (const o of objects) {
        if (o.group)
            for (const q of this.doc.objects())
                if (q.group === o.group && !q.locked)
                    ids.add(q.id);
        if (o.type === 'frame')
            for (const q of this.doc.objects())
                if (q.id !== o.id && !q.locked && contains(bounds(o), bounds(q)))
                    ids.add(q.id);
    } return [...ids].map(id => this.doc.get(id)).filter(o => o && !o.locked); }
    down(e) {
        if (e.button !== 0 && e.button !== 1)
            return;
        this.app.closePopup();
        this.endText();
        this.canvas.focus({ preventScroll: true });
        this.canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, this.screenPoint(e));
        const p = this.point(e), screen = this.screenPoint(e);
        this.lastPoint = p;
        if (this.pointers.size === 2) {
            this.state.preview.clear();
            const pts = [...this.pointers.values()];
            this.drag = { mode: 'pinch', distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), center: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } };
            return;
        }
        if (this.tool === 'hand' || this.space || e.button === 1) {
            this.drag = { mode: 'pan', screen, x: this.camera.x, y: this.camera.y };
            this.canvas.style.cursor = 'grabbing';
            return;
        }
        const hit = this.hit(p);
        if (this.state.voting && hit && this.tool === 'select') {
            this.app.castVote(hit.id);
            return;
        }
        if (this.tool === 'select') {
            const handle = this.findHandle(p);
            if (handle && this.writable) {
                this.drag = { ...handle, start: p, objects: clone(this.chosen()), startAngle: Math.atan2(p.y - handle.center.y, p.x - handle.center.x) };
                return;
            }
            if (hit) {
                let selection = new Set(this.state.selection);
                if (e.shiftKey) {
                    selection.has(hit.id) ? selection.delete(hit.id) : selection.add(hit.id);
                }
                else if (!selection.has(hit.id)) {
                    selection = new Set([hit.id]);
                    if (hit.group)
                        for (const o of this.doc.objects())
                            if (o.group === hit.group)
                                selection.add(o.id);
                }
                this.select([...selection]);
                if (this.writable && !hit.locked && selection.has(hit.id)) {
                    if (e.altKey)
                        this.duplicate(0);
                    this.drag = { mode: 'move', start: p, objects: clone(this.related(this.chosen())), moved: false };
                }
            }
            else {
                if (!e.shiftKey)
                    this.select([]);
                this.drag = { mode: 'marquee', start: p, initial: [...this.state.selection] };
                this.state.marquee = { x: p.x, y: p.y, w: 0, h: 0 };
            }
            this.app.invalidate();
            return;
        }
        if (this.tool === 'laser') {
            this.drag = { mode: 'laser' };
            this.state.laser = [{ ...p, at: Date.now() }];
            this.app.invalidate();
            return;
        }
        if (!this.canEdit())
            return;
        if (this.tool === 'comment') {
            this.app.openComment(p);
            return;
        }
        if (this.tool === 'eraser') {
            this.drag = { mode: 'erase', ids: new Set() };
            if (hit && !hit.locked)
                this.drag.ids.add(hit.id);
            return;
        }
        if (this.tool === 'pen' || this.tool === 'highlighter') {
            const o = makeObject('pen', p.x, p.y, { w: 1, h: 1, points: [[0, 0, e.pressure || .5]], stroke: this.state.stroke || '#45415d', strokeWidth: this.tool === 'highlighter' ? 20 : this.state.penWidth || 3, opacity: this.tool === 'highlighter' ? .35 : 1, fill: 'transparent' });
            this.drag = { mode: 'pen', object: o, start: p };
            this.state.preview.set(o.id, o);
            this.app.invalidate();
            return;
        }
        if (this.tool === 'connector' || this.tool === 'line') {
            const from = hit && !['frame', 'pen', 'connector'].includes(hit.type) ? { id: hit.id, side: 'auto' } : null;
            const o = makeObject('connector', p.x, p.y, { w: 0, h: 0, points: [[0, 0], [0, 0]], from, to: null, route: this.tool === 'line' ? 'straight' : this.state.route || 'elbow', stroke: this.state.stroke || '#817591', strokeWidth: 2, arrowEnd: this.tool !== 'line', fill: 'transparent', text: '' });
            this.drag = { mode: 'connect', object: o, start: p };
            this.state.preview.set(o.id, o);
            this.app.invalidate();
            return;
        }
        const type = this.tool === 'mindmap' ? 'rect' : this.tool;
        const defaults = { sticky: { w: 170, h: 170, text: 'Your next big idea', fill: this.state.fill || '#fff0a6' }, text: { w: 320, h: 85, text: 'Add your text', fontSize: 28 }, rect: { w: 200, h: 110, text: '' }, ellipse: { w: 170, h: 130, text: '' }, diamond: { w: 170, h: 140, text: '' }, triangle: { w: 170, h: 145, text: '' }, frame: { w: 620, h: 410, text: `Frame ${this.doc.objects().filter(o => o.type === 'frame').length + 1}`, fill: '#ffffff', stroke: '#dfe2eb', fontSize: 19, bold: true, radius: 12 }, card: { w: 240, h: 145, text: 'New task', tag: 'TASK', fontSize: 18, stroke: '#dfe2eb' }, table: { w: 480, h: 260, text: '', rows: 4, cols: 3, cells: [['Topic', 'Owner', 'Status'], ['', '', ''], ['', '', ''], ['', '', '']], fontSize: 16 } };
        const opts = defaults[type] || defaults.rect;
        if (this.tool === 'mindmap')
            Object.assign(opts, { text: 'Central idea', tag: 'mindmap', fill: '#e7ddff', align: 'center', fontSize: 22 });
        const o = makeObject(type, p.x, p.y, opts);
        this.drag = { mode: 'create', object: o, start: p, initial: clone(o) };
        this.state.preview.set(o.id, o);
        this.app.invalidate();
    }
    move(e) {
        const p = this.point(e);
        this.lastPoint = p;
        this.pointers.has(e.pointerId) && this.pointers.set(e.pointerId, this.screenPoint(e));
        this.app.collab?.presence({ cursor: p, selection: [...this.state.selection], view: this.app.presenceView(), ghost: [...this.state.preview.values()].slice(0, 30).map(o => ({ x: o.x, y: o.y, w: o.w, h: o.h })) });
        const d = this.drag;
        if (!d) {
            if (this.tool === 'select')
                this.canvas.style.cursor = this.findHandle(p) ? 'nwse-resize' : 'default';
            return;
        }
        if (d.mode === 'pinch') {
            const pts = [...this.pointers.values()];
            if (pts.length < 2)
                return;
            const center = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            this.camera.x += center.x - d.center.x;
            this.camera.y += center.y - d.center.y;
            this.camera.zoomAt(dist / (d.distance || 1), center);
            d.center = center;
            d.distance = dist;
            this.app.viewChanged();
            return;
        }
        if (d.mode === 'pan') {
            const s = this.screenPoint(e);
            this.camera.x = d.x + s.x - d.screen.x;
            this.camera.y = d.y + s.y - d.screen.y;
            this.app.viewChanged();
            return;
        }
        if (d.mode === 'marquee') {
            this.state.marquee = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
            this.app.invalidate();
            return;
        }
        if (d.mode === 'move') {
            let dx = p.x - d.start.x, dy = p.y - d.start.y;
            if (e.shiftKey) {
                if (Math.abs(dx) > Math.abs(dy))
                    dy = 0;
                else
                    dx = 0;
            }
            if (this.state.snap) {
                const b = unionBounds(d.objects);
                dx = Math.round((b.x + dx) / 16) * 16 - b.x;
                dy = Math.round((b.y + dy) / 16) * 16 - b.y;
            }
            this.state.guides = [];
            if (this.state.smartSnap && !e.altKey && d.objects.length < 20) {
                const b = unionBounds(d.objects), targets = this.app.renderer.visible().filter(q => !d.objects.some(o => o.id === q.id) && q.type !== 'frame' && q.type !== 'connector');
                let bestX = 5 / this.camera.zoom, bestY = bestX, snapX = 0, snapY = 0, gx, gy;
                for (const q of targets.slice(0, 500)) {
                    for (const a of [b.x + dx, b.x + dx + b.w / 2, b.x + dx + b.w])
                        for (const t of [q.x, q.x + q.w / 2, q.x + q.w])
                            if (Math.abs(t - a) < bestX) {
                                bestX = Math.abs(t - a);
                                snapX = t - a;
                                gx = { x1: t, y1: Math.min(q.y, b.y + dy) - 20, x2: t, y2: Math.max(q.y + q.h, b.y + dy + b.h) + 20 };
                            }
                    for (const a of [b.y + dy, b.y + dy + b.h / 2, b.y + dy + b.h])
                        for (const t of [q.y, q.y + q.h / 2, q.y + q.h])
                            if (Math.abs(t - a) < bestY) {
                                bestY = Math.abs(t - a);
                                snapY = t - a;
                                gy = { x1: Math.min(q.x, b.x + dx) - 20, y1: t, x2: Math.max(q.x + q.w, b.x + dx + b.w) + 20, y2: t };
                            }
                }
                dx += snapX;
                dy += snapY;
                if (gx)
                    this.state.guides.push(gx);
                if (gy)
                    this.state.guides.push(gy);
            }
            d.moved = Math.hypot(dx, dy) > 2 / this.camera.zoom;
            for (const o of d.objects)
                this.state.preview.set(o.id, { ...o, x: o.x + dx, y: o.y + dy });
        }
        if (d.mode === 'resize') {
            const b = d.box, local = rotatePoint(p, d.center, -d.angle), [hx, hy] = handleCoords[d.index];
            let x = b.x, y = b.y, w = b.w, h = b.h;
            if (hx === 0) {
                x = Math.min(local.x, b.x + b.w - 20);
                w = b.x + b.w - x;
            }
            else if (hx === 1)
                w = Math.max(20, local.x - b.x);
            if (hy === 0) {
                y = Math.min(local.y, b.y + b.h - 20);
                h = b.y + b.h - y;
            }
            else if (hy === 1)
                h = Math.max(20, local.y - b.y);
            if (e.shiftKey) {
                const ratio = b.w / (b.h || 1);
                if (hx !== .5) {
                    h = w / ratio;
                    if (hy === 0)
                        y = b.y + b.h - h;
                }
                else {
                    w = h * ratio;
                    if (hx === 0)
                        x = b.x + b.w - w;
                }
            }
            if (d.objects.length === 1) {
                const o = d.objects[0], center = rotatePoint({ x: x + w / 2, y: y + h / 2 }, d.center, d.angle);
                this.state.preview.set(o.id, { ...o, x: center.x - w / 2, y: center.y - h / 2, w, h });
            }
            else
                for (const o of d.objects) {
                    const sx = w / (b.w || 1), sy = h / (b.h || 1), q = { ...o, x: x + (o.x - b.x) * sx, y: y + (o.y - b.y) * sy, w: Math.max(1, o.w * sx), h: Math.max(1, o.h * sy) };
                    if (o.points)
                        q.points = o.points.map(p => [p[0] * sx, p[1] * sy, p[2] ?? .5]);
                    this.state.preview.set(o.id, q);
                }
        }
        if (d.mode === 'rotate') {
            const o = d.objects[0];
            let rotation = d.angle + (Math.atan2(p.y - d.center.y, p.x - d.center.x) - d.startAngle) * 180 / Math.PI;
            if (e.shiftKey)
                rotation = Math.round(rotation / 15) * 15;
            this.state.preview.set(o.id, { ...o, rotation });
        }
        if (d.mode === 'create') {
            const delta = Math.hypot(p.x - d.start.x, p.y - d.start.y);
            if (delta > 6 / this.camera.zoom) {
                let w = Math.max(20, Math.abs(p.x - d.start.x)), h = Math.max(20, Math.abs(p.y - d.start.y));
                if (e.shiftKey)
                    h = w;
                d.object = { ...d.initial, x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w, h };
                this.state.preview.set(d.object.id, d.object);
            }
        }
        if (d.mode === 'connect') {
            const start = d.start, hit = this.hit(p, [d.object.id]), x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
            d.object = { ...d.object, x, y, w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y), points: [[start.x - x, start.y - y], [p.x - x, p.y - y]], to: hit && !['frame', 'pen', 'connector'].includes(hit.type) && hit.id !== d.object.from?.id ? { id: hit.id, side: 'auto' } : null };
            this.state.preview.set(d.object.id, d.object);
        }
        if (d.mode === 'endpoint') {
            const hit = this.hit(p, [d.object.id]), attachment = hit && !['frame', 'pen', 'connector'].includes(hit.type) ? { id: hit.id, side: 'auto' } : null, start = d.endpoint === 'from' ? p : d.fixed, end = d.endpoint === 'to' ? p : d.fixed, x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
            const o = { ...d.object, x, y, w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y), points: [[start.x - x, start.y - y], [end.x - x, end.y - y]], [d.endpoint]: attachment };
            this.state.preview.set(o.id, o);
        }
        if (d.mode === 'pen') {
            const coalesced = e.getCoalescedEvents?.();
            const events = coalesced?.length ? coalesced : [e];
            for (const event of events) {
                const pp = this.point(event), last = d.object.points.at(-1);
                if (Math.hypot(pp.x - d.start.x - last[0], pp.y - d.start.y - last[1]) > 1 / this.camera.zoom && d.object.points.length < 14500)
                    d.object.points.push([pp.x - d.start.x, pp.y - d.start.y, event.pressure || .5]);
            }
            const xs = d.object.points.map(p => p[0]), ys = d.object.points.map(p => p[1]);
            d.object.w = Math.max(...xs) - Math.min(...xs) || 1;
            d.object.h = Math.max(...ys) - Math.min(...ys) || 1;
            this.state.preview.set(d.object.id, { ...d.object });
        }
        if (d.mode === 'erase') {
            const hit = this.hit(p);
            if (hit && !hit.locked) {
                d.ids.add(hit.id);
                this.state.selection = new Set(d.ids);
            }
        }
        if (d.mode === 'laser')
            this.state.laser.push({ ...p, at: Date.now() });
        this.app.invalidate();
    }
    up(e) {
        this.pointers.delete(e.pointerId);
        const d = this.drag;
        if (!d)
            return;
        if (d.mode === 'pinch') {
            if (this.pointers.size === 1) {
                const s = [...this.pointers.values()][0];
                this.drag = { mode: 'pan', screen: s, x: this.camera.x, y: this.camera.y };
            }
            else
                this.drag = null;
            return;
        }
        if (d.mode === 'marquee') {
            const b = this.state.marquee;
            this.select([...new Set([...d.initial, ...this.doc.objects().filter(o => o.type !== 'frame' && intersects(bounds(o), b)).map(o => o.id)])]);
        }
        if (['move', 'resize', 'rotate', 'endpoint'].includes(d.mode) && (d.mode !== 'move' || d.moved)) {
            const changes = [...this.state.preview.values()].map(o => { const old = this.doc.get(o.id); return { id: o.id, props: Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== 'id' && JSON.stringify(v) !== JSON.stringify(old?.[k]))) }; }).filter(c => Object.keys(c.props).length);
            this.app.execute(changes, d.mode === 'move' ? 'Move objects' : d.mode === 'resize' ? 'Resize objects' : d.mode === 'endpoint' ? 'Reconnect line' : 'Rotate object');
        }
        if (['create', 'pen', 'connect'].includes(d.mode)) {
            let o = d.object;
            if (d.mode === 'pen' && o.points.length < 2)
                o.points.push([1, 1, .5]);
            if (d.mode === 'pen') {
                const minX = Math.min(...o.points.map(p => p[0])), minY = Math.min(...o.points.map(p => p[1]));
                o = { ...o, x: o.x + minX, y: o.y + minY, points: o.points.map(p => [p[0] - minX, p[1] - minY, p[2]]) };
            }
            if (d.mode === 'connect' && o.w + o.h < 3) {
                o.w = 200;
                o.points = [[0, 0], [200, 0]];
            }
            const { id, ...props } = o;
            this.app.execute([{ id, props }], `Create ${o.type}`);
            this.select([id]);
            if (d.mode === 'create' && ['sticky', 'text', 'card'].includes(o.type)) {
                this.setTool('select');
                this.editText(this.doc.get(id));
            }
            else if (d.mode === 'create')
                this.setTool('select');
        }
        if (d.mode === 'erase')
            this.app.execute([...d.ids].map(id => ({ id, props: { $deleted: true } })), 'Erase objects');
        this.state.preview.clear();
        this.state.marquee = null;
        this.state.guides = [];
        this.drag = null;
        this.app.collab?.presence({ ghost: [] });
        this.app.invalidate();
        this.app.selectionChanged();
        this.updateCursor();
    }
    cancel(e) { if (e)
        this.pointers.delete(e.pointerId);
    else
        this.pointers.clear(); this.drag = null; this.state.preview.clear(); this.state.marquee = null; this.state.guides = []; this.app.invalidate(); this.updateCursor(); }
    doubleClick(e) { if (!this.writable)
        return; const p = this.point(e); for (const comment of this.doc.all().filter(o => o.type === 'comment' && !o.parent)) {
        if (Math.hypot(comment.x - p.x, comment.y - p.y) < 18 / this.camera.zoom) {
            this.app.openComments(comment.id);
            return;
        }
    } const o = this.hit(p); if (o) {
        this.select([o.id]);
        if (o.type === 'table')
            this.app.editTable(o);
        else if (o.type === 'card')
            this.app.editCard(o);
        else if (o.type !== 'image' && o.type !== 'pen')
            this.editText(o);
    }
    else {
        const o = makeObject('sticky', p.x - 85, p.y - 85, { fill: this.state.fill || '#fff0a6' });
        const { id, ...props } = o;
        this.app.execute([{ id, props }], 'Create note');
        this.select([id]);
        this.editText(this.doc.get(id));
    } }
    editText(o) {
        if (!o || o.locked || !this.canEdit()) return;
        this.endText(); this.select([o.id]);
        const area = document.createElement('div'); area.className = 'canvas-editor rich-editor'; area.setAttribute('aria-label', 'Edit object text');
        const c = this.camera, editorPoint = rotatePoint({ x: o.x, y: o.type === 'frame' ? o.y - 40 : o.y }, { x: o.x + o.w / 2, y: o.y + o.h / 2 }, o.rotation || 0), p = c.screen(editorPoint), h = o.type === 'frame' ? 38 : o.h;
        Object.assign(area.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${Math.max(o.w, 100)}px`, height: `${Math.max(h, 40)}px`, fontSize: `${o.fontSize || 18}px`, fontWeight: o.bold ? '600' : '400', fontStyle: o.italic ? 'italic' : 'normal', textAlign: o.align || 'left', padding: o.type === 'text' || o.type === 'frame' ? '0px' : '15px', background: o.fill && o.fill !== 'transparent' ? o.fill : '#ffffff', transform: `scale(${c.zoom}) rotate(${o.rotation || 0}deg)` });
        document.getElementById('text-edit-layer').append(area); this.textEdit = { o, area };
        this.textEdit.rich = new RichTextEditor(this, o, area);
    }
    endText(commit = true) {
        const ed = this.textEdit; if (!ed) return;
        this.textEdit = null; ed.rich?.destroy(commit); ed.area.remove();
    }
    wheel(e) { e.preventDefault(); this.endText(); if (e.ctrlKey || e.metaKey || !this.state.trackpad) {
        this.camera.zoomAt(Math.exp(-e.deltaY * .0015), this.screenPoint(e));
    }
    else {
        this.camera.x -= e.deltaX;
        this.camera.y -= e.deltaY;
    } this.app.viewChanged(); }
    key(e) {
        if (this.isTyping(e.target) || this.app.modalOpen)
            return;
        const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
        if (this.state.presenting) {
            if (['ArrowRight', 'ArrowDown', ' '].includes(e.key)) {
                e.preventDefault();
                this.app.presentationStep(1);
            }
            if (['ArrowLeft', 'ArrowUp'].includes(e.key)) {
                e.preventDefault();
                this.app.presentationStep(-1);
            }
            if (e.key === 'Escape')
                this.app.stopPresenting();
            return;
        }
        if (e.code === 'Space') {
            e.preventDefault();
            this.space = true;
            this.updateCursor();
            return;
        }
        if (e.key === 'Escape') {
            this.cancel();
            this.select([]);
            this.setTool('select');
            this.app.closePanel();
            this.app.closePopup();
            return;
        }
        if (mod) {
            if (['z', 'y', 'a', 'd', 'g', 'f', 'k', 's', 'o'].includes(k))
                e.preventDefault();
            if (k === 'z')
                e.shiftKey ? this.app.redo() : this.app.undo();
            if (k === 'y')
                this.app.redo();
            if (k === 'a')
                this.select(this.doc.objects().filter(o => o.type !== 'frame').map(o => o.id));
            if (k === 'd')
                this.duplicate();
            if (k === 'g')
                e.shiftKey ? this.ungroup() : this.group();
            if (k === 'f')
                this.app.openSearch();
            if (k === 'k')
                this.app.commandPalette();
            if (k === 's')
                this.app.exportFile('json');
            if (k === 'o')
                this.app.chooseFile('import');
            return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this.remove();
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            if (this.chosen()[0]?.tag === 'mindmap')
                this.addMindmapChild();
            else
                this.app.toast('Select a mind-map node to add a connected idea with Tab.');
            return;
        }
        if (e.shiftKey && k === '1') {
            e.preventDefault();
            this.app.fit();
            return;
        }
        if (e.shiftKey && k === '2') {
            e.preventDefault();
            this.app.fitSelection();
            return;
        }
        if (e.key.startsWith('Arrow') && this.state.selection.size) {
            e.preventDefault();
            if (!this.canEdit())
                return;
            const n = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0, dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
            this.app.execute(this.related(this.chosen()).map(o => ({ id: o.id, props: { x: o.x + dx, y: o.y + dy } })), 'Nudge objects');
            return;
        }
        if (k === '+' || k === '=') {
            this.app.zoom(1.15);
            return;
        }
        if (k === '-') {
            this.app.zoom(1 / 1.15);
            return;
        }
        if (k === '?') {
            this.app.help();
            return;
        }
        const tools = { v: 'select', h: 'hand', n: 'sticky', t: 'text', s: 'rect', r: 'rect', o: 'ellipse', d: 'diamond', l: 'line', c: 'connector', p: 'pen', e: 'eraser', f: 'frame', m: 'comment' };
        if (tools[k]) {
            e.preventDefault();
            this.setTool(tools[k]);
        }
    }
    remove() { if (!this.canEdit())
        return; const chosen = this.chosen().filter(o => !o.locked); this.app.execute(chosen.map(o => ({ id: o.id, props: { $deleted: true } })), 'Delete objects'); this.select([]); }
    duplicate(offset = 28) { if (!this.canEdit())
        return; return this.pasteObjects(this.related(this.chosen()), offset); }
    pasteObjects(objects, offset = 28, at = null) { if (!objects.length)
        return; const ids = new Map(objects.map(o => [o.id, uid(o.type)])), groups = new Map(), box = unionBounds(objects); const dx = at ? at.x - box.x : offset, dy = at ? at.y - box.y : offset; const copies = objects.map(o => { const q = { ...clone(o), id: ids.get(o.id), x: o.x + dx, y: o.y + dy, z: Date.now() + Math.random(), $deleted: false, locked: false }; if (q.group) {
        if (!groups.has(q.group))
            groups.set(q.group, uid('group'));
        q.group = groups.get(q.group);
    } if (q.from) {
        q.from = ids.has(q.from.id) ? { ...q.from, id: ids.get(q.from.id) } : null;
    } if (q.to) {
        q.to = ids.has(q.to.id) ? { ...q.to, id: ids.get(q.to.id) } : null;
    } return q; }); this.app.execute(copies.map(({ id, ...props }) => ({ id, props })), 'Paste objects'); this.select(copies.map(o => o.id)); return copies; }
    copy(system = true) { const objects = this.related(this.chosen()); this.clipboard = clone(objects); const text = JSON.stringify({ format: 'orivane/clipboard', objects }); if (system)
        navigator.clipboard?.writeText(text).then(() => this.app.toast(`${objects.length} object${objects.length === 1 ? '' : 's'} copied`)).catch(() => this.app.toast('Press Ctrl+C / ⌘C to copy the selection.')); return text; }
    async paste() { if (!this.canEdit())
        return; try {
        const text = await navigator.clipboard.readText();
        this.pasteText(text);
    }
    catch {
        if (this.clipboard.length)
            this.pasteObjects(this.clipboard);
        else
            this.app.toast('Paste with Ctrl+V / ⌘V, or your device’s Paste command.');
    } }
    pasteEvent(e) { if (this.isTyping(e.target) || this.app.modalOpen || !this.writable)
        return; e.preventDefault(); const files = [...e.clipboardData.files]; if (files.length)
        this.app.importFiles(files, this.center());
    else
        this.pasteText(e.clipboardData.getData('text/plain')); }
    pasteText(text) { if (!this.canEdit() || !text)
        return; try {
        const data = JSON.parse(text);
        if (data.format === 'orivane/clipboard' && Array.isArray(data.objects) && data.objects.length <= 5000) {
            this.pasteObjects(data.objects, 28);
            return;
        }
    }
    catch { } const lines = text.slice(0, 40000).split('\n').filter(Boolean), center = this.center(); if (lines.length > 1 && lines.length < 101) {
        const objects = lines.map((t, i) => makeObject('sticky', center.x + (i % 4) * 194, center.y + Math.floor(i / 4) * 194, { text: t, fill: this.state.fill || '#fff0a6' }));
        this.app.execute(objects.map(({ id, ...props }) => ({ id, props })), 'Paste notes');
        this.select(objects.map(o => o.id));
    }
    else {
        const o = makeObject('text', center.x, center.y, { text, w: 430, h: Math.max(80, lines.length * 32), fontSize: 24 });
        const { id, ...props } = o;
        this.app.execute([{ id, props }], 'Paste text');
        this.select([id]);
    } }
    center() { return this.camera.world({ x: this.app.renderer.width / 2, y: this.app.renderer.height / 2 }); }
    group() { if (!this.canEdit())
        return; const items = this.chosen(); if (items.length < 2)
        return this.app.toast('Select at least two objects to group.'); const group = uid('group'); this.app.execute(items.map(o => ({ id: o.id, props: { group } })), 'Group objects'); }
    ungroup() { if (!this.canEdit())
        return; this.app.execute(this.chosen().map(o => ({ id: o.id, props: { group: null } })), 'Ungroup objects'); }
    align(direction) { if (!this.canEdit())
        return; const items = this.chosen().filter(o => !o.locked); if (items.length < 2)
        return; const b = unionBounds(items); this.app.execute(items.map(o => ({ id: o.id, props: direction === 'left' ? { x: b.x } : direction === 'center' ? { x: b.x + (b.w - o.w) / 2 } : direction === 'right' ? { x: b.x + b.w - o.w } : direction === 'top' ? { y: b.y } : direction === 'middle' ? { y: b.y + (b.h - o.h) / 2 } : { y: b.y + b.h - o.h } })), 'Align objects'); }
    distribute(axis = 'x') { if (!this.canEdit())
        return; const items = this.chosen().filter(o => !o.locked).sort((a, b) => a[axis] - b[axis]); if (items.length < 3)
        return this.app.toast('Select at least three objects to distribute.'); const size = axis === 'x' ? 'w' : 'h', start = items[0][axis], end = items.at(-1)[axis] + items.at(-1)[size], total = items.reduce((sum, o) => sum + o[size], 0), gap = (end - start - total) / (items.length - 1); let pos = start; const changes = items.map(o => { const c = { id: o.id, props: { [axis]: pos } }; pos += o[size] + gap; return c; }); this.app.execute(changes, 'Distribute objects'); }
    addMindmapChild() { if (!this.canEdit())
        return; const p = this.chosen()[0]; if (!p)
        return; const children = this.doc.objects().filter(o => o.type === 'connector' && o.from?.id === p.id); const node = makeObject('rect', p.x + p.w + 110, p.y + children.length * 120, { w: 200, h: 80, text: 'Connected idea', fill: '#e6dfff', align: 'center', tag: 'mindmap' }); const connector = makeObject('connector', p.x + p.w, p.y + p.h / 2, { w: 110, h: 0, from: { id: p.id, side: 'right' }, to: { id: node.id, side: 'left' }, stroke: '#a58ed0', strokeWidth: 2, route: 'curve', arrowEnd: false, text: '' }); this.app.execute([node, connector].map(({ id, ...props }) => ({ id, props })), 'Add connected idea'); this.select([node.id]); this.editText(this.doc.get(node.id)); }
    destroy() { this.endText(); this.abort.abort(); }
}
