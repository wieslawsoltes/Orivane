import { unionBounds, Camera } from './geometry.js';
import { LabelAtlas, buildScene, drawCanvasCommands } from '../render/scene.js';
import { makeObject } from './model.js';
const xml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function downloadFile(content, name, type = 'application/octet-stream') { const blob = content instanceof Blob ? content : new Blob([content], { type }); const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
export async function exportScene(doc, format = 'png', objects = doc.objects(), options = {}) {
    const sorted = objects.slice().sort((a, b) => (a.type === 'frame' ? -1 : 0) - (b.type === 'frame' ? -1 : 0) || (a.z || 0) - (b.z || 0));
    const box = unionBounds(sorted);
    box.y -= 50;
    box.h += 50;
    const pad = 30;
    const atlas = new LabelAtlas(null, () => { });
    await Promise.all(sorted.filter(o => o.type === 'image').map(o => new Promise(resolve => { const image = atlas.getImage(o.src); if (image.complete)
        return resolve(); image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); setTimeout(resolve, 4000); })));
    const commands = buildScene(sorted, id => doc.get(id), atlas, 1);
    if (format === 'svg') {
        const elements = commands.map(c => { const transform = c.rotation ? ` transform="rotate(${c.rotation} ${c.x + c.w / 2} ${c.y + c.h / 2})"` : ''; if (c.kind === 4 && c.image)
            return `<image x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" href="${c.image.toDataURL('image/png')}" opacity="${c.opacity ?? 1}"${transform}/>`; const style = `fill="${xml(c.fill === 'transparent' || !c.fill ? 'none' : c.fill)}" stroke="${xml(c.stroke === 'transparent' || !c.stroke ? 'none' : c.stroke)}" stroke-width="${c.sw || 0}" opacity="${c.opacity ?? 1}"${transform}`; if (c.kind === 1)
            return `<ellipse cx="${c.x + c.w / 2}" cy="${c.y + c.h / 2}" rx="${c.w / 2}" ry="${c.h / 2}" ${style}/>`; if (c.kind === 2)
            return `<polygon points="${c.x + c.w / 2},${c.y} ${c.x + c.w},${c.y + c.h / 2} ${c.x + c.w / 2},${c.y + c.h} ${c.x},${c.y + c.h / 2}" ${style}/>`; if (c.kind === 3)
            return `<polygon points="${c.x + c.w / 2},${c.y} ${c.x + c.w},${c.y + c.h} ${c.x},${c.y + c.h}" ${style}/>`; return `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${c.radius || 0}" ${style}/>`; });
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w + pad * 2}" height="${box.h + pad * 2}" viewBox="${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}"><title>Orivane board export</title><rect x="${box.x - pad}" y="${box.y - pad}" width="${box.w + pad * 2}" height="${box.h + pad * 2}" fill="${options.transparent ? 'none' : '#f3f4f8'}"/>${elements.join('')}</svg>`;
    }
    const scale = Math.min(options.scale || 2, 8192 / (box.w + pad * 2), 8192 / (box.h + pad * 2), Math.sqrt(32000000 / ((box.w + pad * 2) * (box.h + pad * 2))));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((box.w + pad * 2) * scale);
    canvas.height = Math.ceil((box.h + pad * 2) * scale);
    const camera = { x: (-box.x + pad) * scale, y: (-box.y + pad) * scale, zoom: scale };
    drawCanvasCommands(canvas.getContext('2d'), commands, camera, canvas.width, canvas.height, options.transparent ? null : '#f3f4f8');
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
export function thumbnail(doc, width = 420, height = 240) { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const camera = new Camera(); camera.fit(unionBounds(doc.objects()), width, height, 15); const atlas = new LabelAtlas(null, () => { }); const commands = buildScene(doc.objects().slice().sort((a, b) => (a.type === 'frame' ? -1 : 0) - (b.type === 'frame' ? -1 : 0) || (a.z || 0) - (b.z || 0)), id => doc.get(id), atlas, Math.max(.2, camera.zoom)); drawCanvasCommands(canvas.getContext('2d'), commands, camera, width, height, '#f3f4f8'); return canvas.toDataURL('image/png'); }
export function exportCSV(objects) { const rows = [['Type', 'Text', 'X', 'Y', 'Width', 'Height', 'Tag', 'Assignee', 'Status'], ...objects.map(o => [o.type, o.text || '', o.x, o.y, o.w, o.h, o.tag || '', o.assignee || '', o.status || ''])]; return '\ufeff' + rows.map(r => r.map(v => `"${String(typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""')}"`).join(',')).join('\r\n'); }
/** Conservative SVG import. Script, embedded HTML, remote URLs, CSS and filters
 * are never inserted in the document. Unsupported elements are reported.
 */
export function importSimpleSVG(text) {
    if (text.length > 8000000)
        throw Error('SVG is too large');
    const dom = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (dom.querySelector('parsererror') || dom.documentElement.localName !== 'svg')
        throw Error('Invalid SVG');
    const objects = [], warnings = new Set();
    const color = (value, fallback) => /^#[\da-f]{6}$/i.test(value || '') ? value : value === 'none' ? 'transparent' : fallback;
    const number = (el, name, fallback = 0) => { const n = parseFloat(el.getAttribute(name)); return Number.isFinite(n) ? Math.max(-1e7, Math.min(1e7, n)) : fallback; };
    for (const el of dom.querySelectorAll('rect,circle,ellipse,text,line,polyline,polygon,path,image,foreignObject')) {
        if (el.closest('[transform]')) {
            warnings.add('Transformed SVG elements were skipped');
            continue;
        }
        if (objects.length >= 5000) {
            warnings.add('Only the first 5,000 supported elements were imported');
            break;
        }
        const tag = el.localName, props = { fill: color(el.getAttribute('fill'), '#ffffff'), stroke: color(el.getAttribute('stroke'), '#45415d'), strokeWidth: number(el, 'stroke-width', 1), fontSize: number(el, 'font-size', 20), text: '' };
        let type = tag, x = number(el, 'x'), y = number(el, 'y'), w = number(el, 'width', 100), h = number(el, 'height', 100);
        if (tag === 'circle' || tag === 'ellipse') {
            type = 'ellipse';
            const rx = number(el, tag === 'circle' ? 'r' : 'rx', 50), ry = number(el, tag === 'circle' ? 'r' : 'ry', 50);
            x = number(el, 'cx') - rx;
            y = number(el, 'cy') - ry;
            w = rx * 2;
            h = ry * 2;
        }
        else if (tag === 'text') {
            type = 'text';
            props.text = el.textContent.slice(0, 40000);
            props.color = color(el.getAttribute('fill'), '#25283d');
            props.fill = 'transparent';
            w = Math.max(120, props.text.length * props.fontSize * .55);
            h = props.fontSize * 1.6;
            y -= props.fontSize;
        }
        else if (tag === 'rect') {
            props.radius = number(el, 'rx');
        }
        else if (tag === 'line') {
            type = 'connector';
            const x1 = number(el, 'x1'), y1 = number(el, 'y1'), x2 = number(el, 'x2'), y2 = number(el, 'y2');
            x = Math.min(x1, x2);
            y = Math.min(y1, y2);
            w = Math.abs(x2 - x1);
            h = Math.abs(y2 - y1);
            props.points = [[x1 - x, y1 - y], [x2 - x, y2 - y]];
            props.arrowEnd = false;
            props.route = 'straight';
        }
        else if (tag === 'image' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(el.getAttribute('href') || '')) {
            props.src = el.getAttribute('href');
        }
        else {
            warnings.add(`${tag} elements were skipped`);
            continue;
        }
        objects.push(makeObject(type, x, y, { ...props, w: Math.max(0, w), h: Math.max(0, h) }));
    }
    return { objects, warnings: [...warnings] };
}
