import { connectorPoints } from '../core/geometry.js';
function rounded(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(r || 0, w / 2, h / 2)); }
export function wrapText(ctx, text, width) { const lines = []; for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width <= width) {
            line = test;
            continue;
        }
        if (line) {
            lines.push(line);
            line = '';
        }
        if (ctx.measureText(word).width > width) {
            for (const char of word) {
                if (line && ctx.measureText(line + char).width > width) {
                    lines.push(line);
                    line = char;
                }
                else
                    line += char;
            }
        }
        else
            line = word;
    }
    lines.push(line);
} return lines; }
/** Wrap and paint rich runs in the same atlas used by both renderers. */
export function drawRichText(ctx, object, width, height, padding, frame = false) {
    const fs = object.fontSize || (frame ? 16 : 18), lineHeight = fs * 1.38, available = Math.max(1, width - padding * 2);
    const font = marks => `${(marks.italic ?? object.italic) ? 'italic ' : ''}${(marks.bold ?? (object.bold || frame)) ? '600 ' : '400 '}${fs}px ${marks.code ? 'monospace' : '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'}`;
    const lines = [{ parts: [], width: 0 }];
    for (const run of object.richText || [{ text: object.text || '', marks: {} }]) {
        const marks = run.marks || {}; ctx.font = font(marks);
        // Preserve whitespace and break oversized tokens by Unicode code point.
        for (const token of run.text.split(/(\n|[ \t]+)/)) {
            if (!token) continue;
            if (token === '\n') { lines.push({ parts: [], width: 0 }); continue; }
            let line = lines.at(-1), measured = ctx.measureText(token).width;
            if (measured <= available) {
                if (line.parts.length && line.width + measured > available && !/^\s+$/.test(token)) { line = { parts: [], width: 0 }; lines.push(line); }
                line.parts.push({ text: token, marks, width: measured }); line.width += measured;
            } else for (const ch of token) { const w = ctx.measureText(ch).width; line = lines.at(-1); if (line.width + w > available && line.parts.length) { line = { parts: [], width: 0 }; lines.push(line); } line.parts.push({ text: ch, marks, width: w }); line.width += w; }
        }
    }
    const start = frame ? height / 2 : object.type === 'text' ? fs * .7 : object.type === 'card' ? 28 : Math.max(padding + fs / 2, (height - lines.length * lineHeight) / 2 + lineHeight / 2);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    lines.forEach((line, index) => {
        const y = start + index * lineHeight; if (y > height + lineHeight || y < -lineHeight) return;
        let x = object.align === 'center' && !frame ? (width - line.width) / 2 : object.align === 'right' && !frame ? width - padding - line.width : padding;
        for (const part of line.parts) {
            const m = part.marks; ctx.font = font(m);
            if (m.highlight || m.code) { ctx.fillStyle = m.highlight || '#eeeaf7'; ctx.fillRect(x, y - fs * .59, part.width, fs * 1.18); }
            ctx.fillStyle = m.color || (m.link ? '#6351c9' : object.color || '#25283d'); ctx.fillText(part.text, x, y);
            if (m.underline || m.link || m.strike) { ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = Math.max(.8, fs / 18); ctx.beginPath(); if (m.underline || m.link) { ctx.moveTo(x, y + fs * .42); ctx.lineTo(x + part.width, y + fs * .42); } if (m.strike) { ctx.moveTo(x, y); ctx.lineTo(x + part.width, y); } ctx.stroke(); }
            x += part.width;
        }
    });
}
export class LabelAtlas {
    constructor(gpu, invalidate) { this.gpu = gpu; this.invalidate = invalidate; this.size = gpu?.atlasSize || 4096; this.cache = new Map(); this.x = 2; this.y = 2; this.row = 0; this.full = false; this.images = new Map(); this.frame = 0; }
    reset() { this.cache.clear(); this.x = 2; this.y = 2; this.row = 0; this.full = false; }
    begin() { this.frame++; if (this.full || this.cache.size > 2200)
        this.reset(); }
    getImage(src) { let image = this.images.get(src); if (!image) {
        image = new Image();
        image.onload = () => { this.cache.clear(); this.invalidate(); };
        image.onerror = () => { image.failed = true; this.invalidate(); };
        image.src = src;
        this.images.set(src, image);
        if (this.images.size > 200) {
            const key = this.images.keys().next().value;
            if (key !== src)
                this.images.delete(key);
        }
    } return image; }
    tile(o, scale = 1) {
        const key = JSON.stringify([o.type, o.text, o.richText, o.color, o.w, o.h, o.fontSize, o.bold, o.italic, o.align, o.tag, o.assignee, o.status, o.rows, o.cols, o.cells, o.src, scale]);
        let tile = this.cache.get(key);
        if (tile)
            return tile;
        const isFrame = o.type === 'frame', isText = o.type === 'text', isImage = o.type === 'image';
        const ww = Math.max(1, o.w), hh = isFrame ? 34 : Math.max(1, o.h);
        const quality = Math.min(scale, 1536 / ww, 1536 / hh);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(ww * quality));
        canvas.height = Math.max(1, Math.ceil(hh * quality));
        const ctx = canvas.getContext('2d');
        ctx.scale(quality, quality);
        if (isImage) {
            const image = this.getImage(o.src);
            if (image.complete && image.naturalWidth)
                ctx.drawImage(image, 0, 0, ww, hh);
            else {
                ctx.fillStyle = '#eef0f7';
                ctx.fillRect(0, 0, ww, hh);
                ctx.font = '14px sans-serif';
                ctx.fillStyle = '#777c91';
                ctx.fillText(image.failed ? 'Image unavailable' : 'Loading image…', 12, 28);
            }
        }
        else if (o.type === 'table') {
            const rows = o.rows || 3, cols = o.cols || 3, cw = ww / cols, ch = hh / rows;
            ctx.font = `${o.fontSize || 15}px sans-serif`;
            ctx.textBaseline = 'middle';
            for (let r = 0; r < rows; r++)
                for (let c = 0; c < cols; c++) {
                    ctx.fillStyle = r === 0 ? '#eeeafd' : '#ffffff';
                    ctx.fillRect(c * cw, r * ch, cw, ch);
                    ctx.strokeStyle = '#d9dce6';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(c * cw, r * ch, cw, ch);
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(c * cw + 8, r * ch + 2, cw - 16, ch - 4);
                    ctx.clip();
                    ctx.fillStyle = '#292c44';
                    ctx.fillText(o.cells?.[r]?.[c] || '', c * cw + 12, r * ch + ch / 2);
                    ctx.restore();
                }
        }
        else {
            const fs = o.fontSize || (isFrame ? 16 : 18), pad = isText || isFrame ? 0 : o.type === 'card' ? 18 : 16;
            ctx.font = `${o.italic ? 'italic ' : ''}${o.bold || isFrame ? '600 ' : '400 '}${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.fillStyle = o.color || '#25283d';
            ctx.textAlign = o.align || 'left';
            if (isFrame)
                ctx.textAlign = 'left';
            const lines = wrapText(ctx, o.text || '', ww - pad * 2), lineHeight = fs * 1.38;
            let start = isFrame ? hh / 2 : isText ? fs * .7 : o.type === 'card' ? 28 : Math.max(pad + fs / 2, (hh - lines.length * lineHeight) / 2 + lineHeight / 2);
            const x = ctx.textAlign === 'center' ? ww / 2 : ctx.textAlign === 'right' ? ww - pad : pad;
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, ww, hh);
            ctx.clip();
            if (o.richText?.length) drawRichText(ctx, o, ww, hh, pad, isFrame);
            else for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x, start + i * lineHeight);
            ctx.restore();
            if (o.type === 'card') {
                ctx.font = '500 11px sans-serif';
                ctx.textAlign = 'left';
                const tag = o.tag || 'TASK';
                const tw = ctx.measureText(tag).width + 16;
                ctx.fillStyle = '#efecff';
                rounded(ctx, 16, hh - 39, tw, 22, 5);
                ctx.fill();
                ctx.fillStyle = '#6550b9';
                ctx.fillText(tag, 24, hh - 27);
                ctx.fillStyle = '#7d8398';
                ctx.textAlign = 'right';
                ctx.fillText(o.assignee || 'Unassigned', ww - 16, hh - 27);
            }
        }
        tile = { canvas, w: ww, h: hh, uv: [0, 0, 0, 0] };
        if (this.gpu) {
            if (this.x + canvas.width + 2 > this.size) {
                this.x = 2;
                this.y += this.row + 2;
                this.row = 0;
            }
            if (this.y + canvas.height + 2 > this.size) {
                this.full = true;
                return null;
            }
            this.gpu.upload(canvas, this.x, this.y);
            tile.uv = [this.x / this.size, this.y / this.size, canvas.width / this.size, canvas.height / this.size];
            this.x += canvas.width + 2;
            this.row = Math.max(this.row, canvas.height);
        }
        this.cache.set(key, tile);
        return tile;
    }
}
export function addLine(commands, a, b, color, width = 2, dash = false, opacity = 1) {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (length < .001)
        return;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (dash) {
        const step = Math.max(8, width * 5);
        for (let t = 0; t < length; t += step * 1.6) {
            const l = Math.min(step, length - t), f = (t + l / 2) / length;
            commands.push({ x: a.x + dx * f - l / 2, y: a.y + dy * f - width / 2, w: l, h: width, fill: color, rotation: angle, radius: width / 2, opacity });
        }
    }
    else
        commands.push({ x: (a.x + b.x) / 2 - length / 2, y: (a.y + b.y) / 2 - width / 2, w: length, h: width, fill: color, rotation: angle, radius: width / 2, opacity });
}
function arrow(commands, a, b, color, size) { const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90; commands.push({ x: b.x - size / 2, y: b.y - size / 2, w: size, h: size, fill: color, kind: 3, rotation: angle }); }
export function buildScene(objects, lookup, atlas, zoom = 1) {
    const cmds = [];
    atlas.begin();
    for (const o of objects) {
        const opacity = o.opacity ?? 1;
        if (o.type === 'connector') {
            const points = connectorPoints(o, lookup);
            for (let i = 1; i < points.length; i++)
                addLine(cmds, points[i - 1], points[i], o.stroke || '#7c8298', o.strokeWidth || 2, o.dash, opacity);
            if (o.arrowEnd !== false && points.length > 1)
                arrow(cmds, points.at(-2), points.at(-1), o.stroke || '#7c8298', 12);
            if (o.arrowStart && points.length > 1)
                arrow(cmds, points[1], points[0], o.stroke || '#7c8298', 12);
            if (o.text && zoom > .18) {
                const mid = points[Math.floor(points.length / 2)], label = { ...o, type: 'text', w: 180, h: 32, fontSize: o.fontSize || 14, align: 'center' };
                const tile = atlas.tile(label, 1.5);
                if (tile) {
                    cmds.push({ x: mid.x - 90, y: mid.y - 16, w: 180, h: 32, fill: '#ffffff', radius: 6 });
                    cmds.push({ x: mid.x - 90, y: mid.y - 16, w: 180, h: 32, kind: 4, fill: '#ffffff', opacity, uv: tile.uv, image: tile.canvas });
                }
            }
            continue;
        }
        if (o.type === 'pen') {
            const ps = o.points || [];
            for (let i = 1; i < ps.length; i++) {
                const pressure = ((ps[i][2] ?? .5) + (ps[i - 1][2] ?? .5)) / 2;
                addLine(cmds, { x: o.x + ps[i - 1][0], y: o.y + ps[i - 1][1] }, { x: o.x + ps[i][0], y: o.y + ps[i][1] }, o.stroke || '#34394e', (o.strokeWidth || 3) * (.5 + pressure), false, opacity);
            }
            continue;
        }
        if (o.type !== 'text' && o.type !== 'image' && o.type !== 'table') {
            if (o.type === 'sticky' || o.type === 'card')
                cmds.push({ x: o.x + 1.5, y: o.y + 3, w: o.w, h: o.h, fill: '#000000', opacity: .055, radius: o.radius || 1, rotation: o.rotation });
            cmds.push({ x: o.x, y: o.y, w: o.w, h: o.h, fill: o.fill, stroke: o.stroke, sw: o.strokeWidth, radius: o.radius, rotation: o.rotation, kind: o.type === 'ellipse' ? 1 : o.type === 'diamond' ? 2 : o.type === 'triangle' ? 3 : 0, opacity });
            if (o.type === 'sticky')
                cmds.push({ x: o.x + o.w - 15, y: o.y + o.h - 15, w: 15, h: 15, fill: '#000000', opacity: .055, kind: 3, rotation: 180 + (o.rotation || 0) });
        }
        if ((o.text || o.type === 'image' || o.type === 'table') && (zoom > .16 || o.type === 'image' || o.type === 'frame')) {
            const tile = atlas.tile(o, zoom > 1.3 ? 2 : 1.25);
            if (tile)
                cmds.push({ x: o.x, y: o.type === 'frame' ? o.y - 40 : o.y, w: tile.w, h: tile.h, kind: 4, fill: '#ffffff', rotation: o.rotation, opacity, uv: tile.uv, image: tile.canvas });
        }
    }
    return cmds;
}
export function drawCanvasCommands(ctx, commands, camera, width, height, bg, ratio = 1) {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);
    }
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);
    for (const c of commands) {
        ctx.save();
        ctx.translate(c.x + c.w / 2, c.y + c.h / 2);
        ctx.rotate((c.rotation || 0) * Math.PI / 180);
        ctx.globalAlpha = c.opacity ?? 1;
        const x = -c.w / 2, y = -c.h / 2;
        if (c.kind === 4 && c.image) {
            ctx.drawImage(c.image, x, y, c.w, c.h);
            ctx.restore();
            continue;
        }
        ctx.beginPath();
        if (c.kind === 1)
            ctx.ellipse(0, 0, c.w / 2, c.h / 2, 0, 0, Math.PI * 2);
        else if (c.kind === 2) {
            ctx.moveTo(0, y);
            ctx.lineTo(-x, 0);
            ctx.lineTo(0, -y);
            ctx.lineTo(x, 0);
            ctx.closePath();
        }
        else if (c.kind === 3) {
            ctx.moveTo(0, y);
            ctx.lineTo(-x, -y);
            ctx.lineTo(x, -y);
            ctx.closePath();
        }
        else
            ctx.roundRect(x, y, c.w, c.h, Math.min(c.radius || 0, c.w / 2, c.h / 2));
        if (c.fill && c.fill !== 'transparent') {
            ctx.fillStyle = c.fill;
            ctx.fill();
        }
        if (c.stroke && c.stroke !== 'transparent' && c.sw) {
            ctx.strokeStyle = c.stroke;
            ctx.lineWidth = c.sw;
            ctx.stroke();
        }
        ctx.restore();
    }
}
