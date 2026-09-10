export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function rotatePoint(p, c, angle) { const a = angle * Math.PI / 180, s = Math.sin(a), co = Math.cos(a), x = p.x - c.x, y = p.y - c.y; return { x: c.x + x * co - y * s, y: c.y + x * s + y * co }; }
export function bounds(o) {
    if (o.type === 'pen' && o.points?.length) {
        const xs = o.points.map(p => o.x + p[0]), ys = o.points.map(p => o.y + p[1]);
        return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    const ps = [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h }].map(p => rotatePoint(p, c, o.rotation || 0));
    const xs = ps.map(p => p.x), ys = ps.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
export function unionBounds(items) { if (!items.length)
    return { x: 0, y: 0, w: 100, h: 100 }; const bs = items.map(o => bounds(o)); const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y)); return { x, y, w: Math.max(...bs.map(b => b.x + b.w)) - x, h: Math.max(...bs.map(b => b.y + b.h)) - y }; }
export function intersects(a, b) { return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y; }
export function contains(a, b) { return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h; }
export function pointSegment(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1); return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); }
export function anchor(o, side, toward) {
    let c = { x: o.x + o.w / 2, y: o.y + o.h / 2 }, p;
    if (side && side !== 'auto')
        p = side === 'left' ? { x: o.x, y: c.y } : side === 'right' ? { x: o.x + o.w, y: c.y } : side === 'top' ? { x: c.x, y: o.y } : { x: c.x, y: o.y + o.h };
    else {
        const local = rotatePoint(toward, c, -(o.rotation || 0)), dx = local.x - c.x, dy = local.y - c.y;
        let t;
        if (o.type === 'ellipse')
            t = 1 / Math.sqrt((dx / (o.w / 2 || 1)) ** 2 + (dy / (o.h / 2 || 1)) ** 2);
        else if (o.type === 'diamond')
            t = 1 / (Math.abs(dx) / (o.w / 2 || 1) + Math.abs(dy) / (o.h / 2 || 1));
        else
            t = Math.min(Math.abs((o.w / 2) / (dx || 1e-9)), Math.abs((o.h / 2) / (dy || 1e-9)));
        p = { x: c.x + dx * (Number.isFinite(t) ? t : 0), y: c.y + dy * (Number.isFinite(t) ? t : 0) };
    }
    return rotatePoint(p, c, o.rotation || 0);
}
export function connectorPoints(o, lookup) {
    const from = o.from && lookup(o.from.id), to = o.to && lookup(o.to.id);
    let a = { x: o.x, y: o.y }, b = { x: o.x + o.w, y: o.y + o.h };
    if (o.points?.length >= 2) {
        a = { x: o.x + o.points[0][0], y: o.y + o.points[0][1] };
        const p = o.points.at(-1);
        b = { x: o.x + p[0], y: o.y + p[1] };
    }
    const ac = from ? { x: from.x + from.w / 2, y: from.y + from.h / 2 } : a, bc = to ? { x: to.x + to.w / 2, y: to.y + to.h / 2 } : b;
    if (from)
        a = anchor(from, o.from.side, bc);
    if (to)
        b = anchor(to, o.to.side, ac);
    if (o.route === 'elbow') {
        const mx = (a.x + b.x) / 2;
        return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
    }
    if (o.route === 'curve') {
        const dx = Math.max(70, Math.abs(b.x - a.x) * .55), pts = [];
        for (let i = 0; i <= 24; i++) {
            const t = i / 24, s = 1 - t;
            pts.push({ x: s ** 3 * a.x + 3 * s * s * t * (a.x + dx) + 3 * s * t * t * (b.x - dx) + t ** 3 * b.x, y: s ** 3 * a.y + 3 * s * s * t * a.y + 3 * s * t * t * b.y + t ** 3 * b.y });
        }
        return pts;
    }
    return [a, b];
}
export function hitObject(o, p, tolerance = 5, lookup = () => null) {
    if (o.type === 'connector') {
        const ps = connectorPoints(o, lookup);
        return ps.slice(1).some((b, i) => pointSegment(p, ps[i], b) < tolerance + (o.strokeWidth || 1));
    }
    if (o.type === 'pen') {
        const ps = (o.points || []).map(a => ({ x: o.x + a[0], y: o.y + a[1] }));
        return ps.slice(1).some((b, i) => pointSegment(p, ps[i], b) < tolerance + (o.strokeWidth || 2));
    }
    const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    p = rotatePoint(p, c, -(o.rotation || 0));
    const nx = (p.x - c.x) / (o.w / 2 || 1), ny = (p.y - c.y) / (o.h / 2 || 1);
    if (o.type === 'ellipse')
        return nx * nx + ny * ny <= 1.1;
    if (o.type === 'diamond')
        return Math.abs(nx) + Math.abs(ny) <= 1.1;
    if (o.type === 'frame')
        return p.x >= o.x - tolerance && p.x <= o.x + o.w + tolerance && p.y >= o.y - 32 && p.y <= o.y + o.h + tolerance;
    return p.x >= o.x - tolerance && p.x <= o.x + o.w + tolerance && p.y >= o.y - tolerance && p.y <= o.y + o.h + tolerance;
}
export class Camera {
    constructor() { this.x = 0; this.y = 0; this.zoom = 1; }
    screen(p) { return { x: p.x * this.zoom + this.x, y: p.y * this.zoom + this.y }; }
    world(p) { return { x: (p.x - this.x) / this.zoom, y: (p.y - this.y) / this.zoom }; }
    zoomAt(factor, p) { const w = this.world(p); this.zoom = clamp(this.zoom * factor, .035, 8); this.x = p.x - w.x * this.zoom; this.y = p.y - w.y * this.zoom; }
    fit(b, width, height, padding = 100) { this.zoom = clamp(Math.min((width - padding * 2) / (b.w || 100), (height - padding * 2) / (b.h || 100)), .035, 2); this.x = width / 2 - (b.x + b.w / 2) * this.zoom; this.y = height / 2 - (b.y + b.h / 2) * this.zoom; }
    rect(width, height, margin = 100) { const p = this.world({ x: -margin, y: -margin }); return { x: p.x, y: p.y, w: (width + margin * 2) / this.zoom, h: (height + margin * 2) / this.zoom }; }
}
/** Uniform spatial hash; very large items use a separate overflow bucket. */
export class SpatialIndex {
    constructor(cell = 400) { this.cell = cell; this.cells = new Map(); this.large = new Set(); this.boxes = new Map(); }
    rebuild(objects, lookup) { this.cells.clear(); this.large.clear(); this.boxes.clear(); for (const o of objects) {
        let b = bounds(o);
        if (o.type === 'connector') {
            const p = connectorPoints(o, lookup);
            b = { x: Math.min(...p.map(p => p.x)), y: Math.min(...p.map(p => p.y)), w: 0, h: 0 };
            b.w = Math.max(...p.map(p => p.x)) - b.x;
            b.h = Math.max(...p.map(p => p.y)) - b.y;
        }
        if (o.type === 'frame')
            b = { x: b.x, y: b.y - 40, w: b.w, h: b.h + 40 };
        this.boxes.set(o.id, b);
        const x0 = Math.floor(b.x / this.cell), x1 = Math.floor((b.x + b.w) / this.cell), y0 = Math.floor(b.y / this.cell), y1 = Math.floor((b.y + b.h) / this.cell);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) {
            this.large.add(o.id);
            continue;
        }
        for (let x = x0; x <= x1; x++)
            for (let y = y0; y <= y1; y++) {
                const k = `${x},${y}`;
                if (!this.cells.has(k))
                    this.cells.set(k, new Set());
                this.cells.get(k).add(o.id);
            }
    } }
    query(b) { const ids = new Set(this.large); const x0 = Math.floor(b.x / this.cell), x1 = Math.floor((b.x + b.w) / this.cell), y0 = Math.floor(b.y / this.cell), y1 = Math.floor((b.y + b.h) / this.cell); if ((x1 - x0 + 1) * (y1 - y0 + 1) > 50000)
        return new Set([...this.boxes].filter(([, a]) => intersects(a, b)).map(([id]) => id)); for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
            for (const id of this.cells.get(`${x},${y}`) || [])
                ids.add(id); return new Set([...ids].filter(id => intersects(this.boxes.get(id), b))); }
}
