import { GPURenderer } from './gpu.js';
import { LabelAtlas, buildScene, drawCanvasCommands } from './scene.js';
import { SpatialIndex, unionBounds, connectorPoints } from '../core/geometry.js';
export class BoardRenderer {
    constructor(base, overlay, doc, camera, state) { this.base = base; this.overlay = overlay; this.doc = doc; this.camera = camera; this.state = state; this.ctx = overlay.getContext('2d'); this.index = new SpatialIndex(); this.dirty = true; this.indexRev = -1; this.mode = 'Starting'; this.stats = { visible: 0, total: 0, ms: 0, instances: 0 }; this.doc.onChange(() => this.invalidate()); this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(base.parentElement); }
    async init() { try {
        if (new URLSearchParams(location.search).has('canvas'))
            throw Error('Canvas requested');
        this.gpu = await GPURenderer.create(this.base);
        this.mode = 'WebGPU';
        this.gpu.onLost = () => { if (!this.destroyed)
            this.fallback(); };
    }
    catch (e) {
        this.reason = e.message;
        this.fallback();
    } this.atlas = new LabelAtlas(this.gpu, () => this.invalidate()); this.resize(); this.tick = () => { if (this.dirty) {
        this.dirty = false;
        this.draw();
    } this.raf = requestAnimationFrame(this.tick); }; this.tick(); return this; }
    fallback() { if (this.base.getContext('2d') === null) {
        const c = document.createElement('canvas');
        c.id = this.base.id;
        c.className = this.base.className;
        this.base.replaceWith(c);
        this.base = c;
    } this.gpu = null; this.fallbackContext = this.base.getContext('2d'); this.mode = 'Canvas 2D'; this.atlas = new LabelAtlas(null, () => this.invalidate()); this.resize(); }
    resize() { this.width = this.overlay.parentElement.clientWidth; this.height = this.overlay.parentElement.clientHeight; const ratio = Math.min(devicePixelRatio || 1, 2); this.ratio = ratio; for (const c of [this.base, this.overlay]) {
        const w = Math.round(this.width * ratio), h = Math.round(this.height * ratio);
        if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
        }
        c.style.width = this.width + 'px';
        c.style.height = this.height + 'px';
    } this.invalidate(); }
    invalidate() { this.dirty = true; }
    rebuild() { if (this.indexRev !== this.doc.revision) {
        this.indexRev = this.doc.revision;
        this.sorted = this.doc.objects().slice().sort((a, b) => (a.type === 'frame' ? -1 : 0) - (b.type === 'frame' ? -1 : 0) || (a.z || 0) - (b.z || 0) || a.id.localeCompare(b.id));
        this.index.rebuild(this.sorted, id => this.doc.get(id));
    } }
    visible() { this.rebuild(); const ids = this.index.query(this.camera.rect(this.width, this.height)); const preview = this.state.preview; return this.sorted.filter(o => ids.has(o.id) || preview.has(o.id)).map(o => preview.get(o.id) || o).concat([...preview.values()].filter(o => !this.doc.get(o.id))); }
    draw() {
        const start = performance.now(), s = this.state, c = this.camera;
        const objects = this.visible();
        const commands = buildScene(objects, id => s.preview.get(id) || this.doc.get(id), this.atlas, c.zoom);
        const bg = null;
        const step = 24 * c.zoom * Math.pow(2, Math.max(0, Math.ceil(Math.log2(12 / (24 * c.zoom)))));
        const parent = this.base.parentElement;
        parent.style.backgroundImage = s.grid ? `radial-gradient(${s.dark ? '#66617f66' : '#9b96af66'} .7px, transparent .8px)` : 'none';
        parent.style.backgroundSize = `${step}px ${step}px`;
        parent.style.backgroundPosition = `${c.x - step / 2}px ${c.y - step / 2}px`;
        if (this.gpu) {
            try {
                this.gpu.render(commands, c, this.width, this.height, bg);
            }
            catch (e) {
                console.error(e);
                this.fallback();
                return;
            }
        }
        else
            drawCanvasCommands(this.fallbackContext, commands, c, this.width, this.height, bg, this.ratio);
        this.drawOverlay();
        this.stats = { visible: objects.length, total: this.sorted.length, ms: performance.now() - start, instances: commands.length };
        this.onRender?.(this.stats);
    }
    drawOverlay() {
        const ctx = this.ctx, c = this.camera, s = this.state, z = c.zoom;
        ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.scale(z, z);
        const selected = [...s.selection].map(id => s.preview.get(id) || this.doc.get(id)).filter(Boolean);
        for (const o of selected) {
            if (o.type === 'connector') {
                const ps = connectorPoints(o, id => s.preview.get(id) || this.doc.get(id));
                ctx.strokeStyle = '#7457e8';
                ctx.lineWidth = 2 / z;
                ctx.beginPath();
                ps.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
                ctx.stroke();
                for (const p of [ps[0], ps.at(-1)])
                    this.handle(ctx, p.x, p.y, 8 / z);
                continue;
            }
            if (selected.length === 1) {
                ctx.save();
                ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
                ctx.rotate((o.rotation || 0) * Math.PI / 180);
                ctx.translate(-o.w / 2, -o.h / 2);
                ctx.strokeStyle = '#7052df';
                ctx.lineWidth = 1.5 / z;
                ctx.strokeRect(0, 0, o.w, o.h);
                if (!o.locked && o.type !== 'pen') {
                    for (const [x, y] of [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]])
                        this.handle(ctx, o.w * x, o.h * y, 7 / z);
                    ctx.beginPath();
                    ctx.moveTo(o.w / 2, 0);
                    ctx.lineTo(o.w / 2, -24 / z);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(o.w / 2, -28 / z, 4 / z, 0, 6.3);
                    ctx.fillStyle = '#ffffff';
                    ctx.fill();
                    ctx.stroke();
                }
                ctx.restore();
            }
            else {
                ctx.strokeStyle = '#947eed';
                ctx.lineWidth = 1 / z;
                ctx.strokeRect(o.x, o.y, o.w, o.h);
            }
        }
        if (selected.length > 1) {
            const b = unionBounds(selected);
            ctx.strokeStyle = '#7052df';
            ctx.lineWidth = 1.5 / z;
            ctx.setLineDash([5 / z, 3 / z]);
            ctx.strokeRect(b.x, b.y, b.w, b.h);
            ctx.setLineDash([]);
            for (const [x, y] of [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]])
                this.handle(ctx, b.x + b.w * x, b.y + b.h * y, 7 / z);
        }
        if (s.marquee) {
            const b = s.marquee;
            ctx.fillStyle = '#7956df18';
            ctx.strokeStyle = '#7956df';
            ctx.lineWidth = 1 / z;
            ctx.fillRect(b.x, b.y, b.w, b.h);
            ctx.strokeRect(b.x, b.y, b.w, b.h);
        }
        for (const guide of s.guides || []) {
            ctx.strokeStyle = '#c665eb';
            ctx.lineWidth = 1 / z;
            ctx.setLineDash([4 / z, 4 / z]);
            ctx.beginPath();
            ctx.moveTo(guide.x1, guide.y1);
            ctx.lineTo(guide.x2, guide.y2);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        for (const comment of this.doc.all().filter(o => o.type === 'comment' && !o.parent && !o.resolved)) {
            ctx.fillStyle = '#7052df';
            ctx.beginPath();
            ctx.arc(comment.x, comment.y, 13 / z, 0, 6.3);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = `bold ${12 / z}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('…', comment.x, comment.y - 2 / z);
        }
        const session = this.doc.get('workshop_vote');
        if (session) {
            const votes = this.doc.all().filter(o => o.type === 'vote' && o.session === session.session);
            const counts = new Map();
            for (const v of votes)
                counts.set(v.target, (counts.get(v.target) || 0) + 1);
            for (const [id, count] of counts) {
                const o = this.doc.get(id);
                if (!o)
                    continue;
                const p = { x: o.x + o.w - 12, y: o.y + o.h - 10 };
                ctx.fillStyle = '#7052df';
                ctx.beginPath();
                ctx.arc(p.x, p.y, 13 / z, 0, 6.3);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.font = `bold ${12 / z}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(count, p.x, p.y);
            }
        }
        for (const peer of s.peers.values()) {
            if (peer.actor === this.doc.actor)
                continue;
            if (peer.selection)
                for (const id of peer.selection) {
                    const o = this.doc.get(id);
                    if (o) {
                        ctx.strokeStyle = peer.color || '#db668d';
                        ctx.lineWidth = 2 / z;
                        ctx.strokeRect(o.x, o.y, o.w, o.h);
                    }
                }
            for (const ghost of peer.ghost || []) {
                if (!Number.isFinite(ghost.x))
                    continue;
                ctx.strokeStyle = peer.color || '#db668d';
                ctx.setLineDash([4 / z, 3 / z]);
                ctx.strokeRect(ghost.x, ghost.y, ghost.w, ghost.h);
                ctx.setLineDash([]);
            }
            if (peer.cursor) {
                const { x, y } = peer.cursor;
                ctx.save();
                ctx.translate(x, y);
                ctx.scale(1 / z, 1 / z);
                ctx.fillStyle = peer.color || '#db668d';
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(4, 18);
                ctx.lineTo(9, 12);
                ctx.lineTo(17, 10);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.font = '500 11px sans-serif';
                const w = ctx.measureText(peer.name || 'Guest').width;
                ctx.beginPath();
                ctx.roundRect(11, 16, w + 14, 22, 5);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.textAlign = 'left';
                ctx.fillText(peer.name || 'Guest', 18, 28);
                ctx.restore();
            }
        }
        const now = Date.now();
        s.reactions = (s.reactions || []).filter(r => now - r.at < 2500);
        for (const r of s.reactions) {
            ctx.globalAlpha = 1 - (now - r.at) / 2500;
            ctx.font = `${38 / z}px sans-serif`;
            ctx.fillText(r.emoji, r.x, r.y - (now - r.at) * .045 / z);
            ctx.globalAlpha = 1;
        }
        if (s.reactions.length)
            this.invalidate();
        if (s.laser?.length) {
            const pts = s.laser.filter(p => now - p.at < 1500);
            s.laser = pts;
            ctx.strokeStyle = '#fa5368';
            ctx.lineWidth = 4 / z;
            ctx.lineCap = 'round';
            ctx.beginPath();
            pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.stroke();
            if (pts.length)
                this.invalidate();
        }
        ctx.restore();
    }
    handle(ctx, x, y, size) { ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#7052df'; ctx.lineWidth = 1 / this.camera.zoom; ctx.fillRect(x - size / 2, y - size / 2, size, size); ctx.strokeRect(x - size / 2, y - size / 2, size, size); }
    destroy() { this.destroyed = true; cancelAnimationFrame(this.raf); this.resizeObserver.disconnect(); this.gpu?.destroy(); }
}
