import { makeObject, uid, validateProps } from './model.js';
import { connectorPoints } from './geometry.js';
const num = (v, fallback = 0) => v !== null && v !== undefined && v !== '' && Number.isFinite(+v) ? Math.max(-1e7, Math.min(1e7, +v)) : fallback;
const color = (v, fallback = '#595269') => /^#[a-f0-9]{6}$/i.test(v || '') ? v : v === 'transparent' || v === 'none' ? 'transparent' : /^#[a-f0-9]{3}$/i.test(v || '') ? '#' + v.slice(1).split('').map(c => c + c).join('') : fallback;
const xmlEscape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
function plainHTML(input) { if (typeof DOMParser === 'undefined') return String(input || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); const doc = new DOMParser().parseFromString(String(input || ''), 'text/html'); doc.querySelectorAll('script,style,iframe,object').forEach(e => e.remove()); doc.querySelectorAll('br').forEach(e => e.replaceWith('\n')); return doc.body.textContent || ''; }
function validateResult(objects, warnings, source) { if (objects.length > 10000) throw Error('Import is limited to 10,000 objects'); for (const { id, ...props } of objects) validateProps(props); return { objects, warnings: [...new Set(warnings)], source }; }
export function importExcalidraw(data) {
    if (data.type !== 'excalidraw' || !Array.isArray(data.elements) || data.elements.length > 10000) throw Error('Invalid Excalidraw document');
    const objects = [], warnings = [], ids = new Map(data.elements.map(e => [e.id, uid('import')])), groups = new Map();
    const active = data.elements.filter(e => !e.isDeleted), attached = new Map(active.filter(e => e.type === 'text' && e.containerId).map(e => [e.containerId, e]));
    for (const e of active) {
        if (e.type === 'text' && e.containerId && active.some(parent => parent.id === e.containerId)) continue;
        const type = ({ rectangle: 'rect', ellipse: 'ellipse', diamond: 'diamond', text: 'text', arrow: 'connector', line: 'connector', freedraw: 'pen', image: 'image', frame: 'frame' })[e.type];
        if (!type) { warnings.push(`Unsupported shape type: ${e.type}`); continue; }
        const label = attached.get(e.id), text = String(label?.text || e.text || e.name || '').slice(0, 40000), props = { id: ids.get(e.id), w: Math.abs(num(e.width, 160)), h: Math.abs(num(e.height, 100)), text, fill: color(e.backgroundColor, 'transparent'), stroke: color(e.strokeColor), strokeWidth: Math.max(0, Math.min(2000, num(e.strokeWidth, 2))), opacity: num(e.opacity, 100) / 100, rotation: num(e.angle) * 180 / Math.PI, radius: e.roundness ? 10 : 0, fontSize: Math.max(1, Math.min(2000, num(label?.fontSize || e.fontSize, 20))), align: label?.textAlign || e.textAlign || 'left', dash: e.strokeStyle !== 'solid' && !!e.strokeStyle, locked: !!e.locked, z: objects.length };
        if (e.groupIds?.length) { const group = e.groupIds[0]; if (!groups.has(group)) groups.set(group, uid('group')); props.group = groups.get(group); if (e.groupIds.length > 1) warnings.push('Nested groups flattened to their first group'); }
        if (e.link && /^https?:\/\//.test(e.link)) props.url = e.link;
        if (type === 'image') { const file = data.files?.[e.fileId]; if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(file?.dataURL || '')) { warnings.push('Image omitted: missing or unsupported embedded raster'); continue; } props.src = file.dataURL; }
        if (type === 'connector' || type === 'pen') { props.points = (e.points || [[0, 0], [props.w, props.h]]).slice(0, 15000).map((p, i) => [num(p[0]), num(p[1]), ...(type === 'pen' ? [num(e.pressures?.[i], .5)] : [])]); props.route = 'straight'; if (type === 'connector') { props.arrowStart = !!e.startArrowhead; props.arrowEnd = !!e.endArrowhead; if (e.startBinding && ids.has(e.startBinding.elementId)) props.from = { id: ids.get(e.startBinding.elementId), side: 'auto' }; if (e.endBinding && ids.has(e.endBinding.elementId)) props.to = { id: ids.get(e.endBinding.elementId), side: 'auto' }; if (props.points.length > 2) warnings.push('Multi-segment connector waypoints flattened to endpoints'); } }
        if (e.roughness) warnings.push('Hand-drawn roughness is converted to clean vector strokes');
        objects.push(makeObject(type, num(e.x), num(e.y), props));
    }
    return validateResult(objects, warnings, 'Excalidraw');
}
export function exportExcalidraw(doc) {
    const files = {}, elements = [], warnings = [], all = doc.objects(), lookup = id => doc.get(id), mapType = { sticky: 'rectangle', rect: 'rectangle', ellipse: 'ellipse', diamond: 'diamond', text: 'text', frame: 'frame', connector: 'arrow', pen: 'freedraw', image: 'image', card: 'rectangle', triangle: 'diamond', table: 'rectangle' };
    const base = (o, type) => ({ id: o.id, type, x: o.x || 0, y: o.y || 0, width: o.w || 0, height: o.h || 0, angle: (o.rotation || 0) * Math.PI / 180, strokeColor: o.stroke || '#595269', backgroundColor: o.fill || 'transparent', fillStyle: 'solid', strokeWidth: o.strokeWidth ?? 1, strokeStyle: o.dash ? 'dashed' : 'solid', roughness: 0, opacity: Math.round((o.opacity ?? 1) * 100), groupIds: o.group ? [o.group] : [], frameId: null, roundness: o.radius ? { type: 3 } : null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], updated: Date.now(), link: o.url || null, locked: !!o.locked });
    for (const o of all) {
        const type = mapType[o.type]; if (!type) { warnings.push(`Skipped ${o.type}`); continue; }
        const e = base(o, type);
        if (type === 'arrow') { const p = connectorPoints(o, lookup), first = p[0]; e.x = first.x; e.y = first.y; e.points = p.map(p => [p.x - first.x, p.y - first.y]); e.startBinding = o.from ? { elementId: o.from.id, focus: 0, gap: 0 } : null; e.endBinding = o.to ? { elementId: o.to.id, focus: 0, gap: 0 } : null; e.startArrowhead = o.arrowStart ? 'arrow' : null; e.endArrowhead = o.arrowEnd ? 'arrow' : null; e.elbowed = o.route === 'elbow'; }
        if (type === 'freedraw') { e.points = (o.points || []).map(p => p.slice(0, 2)); e.pressures = (o.points || []).map(p => p[2] ?? .5); e.simulatePressure = false; e.lastCommittedPoint = null; }
        if (type === 'image') { e.fileId = o.id; e.status = 'saved'; e.scale = [1, 1]; files[o.id] = { id: o.id, mimeType: o.src.split(';')[0].slice(5), dataURL: o.src, created: Date.now(), lastRetrieved: Date.now() }; }
        if (type === 'frame') e.name = o.text || 'Frame';
        elements.push(e);
        let text = o.type === 'table' ? (o.cells || []).map(r => r.join(' | ')).join('\n') : o.text || '';
        if (text && type !== 'frame' && type !== 'image') {
            const t = type === 'text' ? e : base({ ...o, id: o.id + '_label', x: o.x + 12, y: o.y + 12, w: Math.max(1, o.w - 24), h: Math.max(1, o.h - 24), fill: 'transparent' }, 'text');
            Object.assign(t, { text, originalText: text, fontSize: o.fontSize || 18, fontFamily: 2, textAlign: o.align || 'left', verticalAlign: 'middle', containerId: type === 'text' ? null : o.id, autoResize: true, lineHeight: 1.25 });
            if (t !== e) { elements.push(t); e.boundElements.push({ id: t.id, type: 'text' }); }
        }
        if (o.type === 'table' || o.type === 'card') warnings.push('Tables and task cards export as labelled shapes');
        if (o.richText?.some(r => Object.keys(r.marks || {}).length)) warnings.push('Inline formatting exports as plain text');
        if (o.type === 'triangle') warnings.push('Triangles export as diamonds');
    }
    for (const e of elements.filter(x => x.type === 'arrow')) for (const binding of [e.startBinding, e.endBinding]) { const target = elements.find(x => x.id === binding?.elementId); if (target) target.boundElements.push({ id: e.id, type: 'arrow' }); }
    return { data: { type: 'excalidraw', version: 2, source: 'Orivane', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files }, warnings: [...new Set(warnings)] };
}
async function inflate(value) {
    if (typeof DecompressionStream === 'undefined') throw Error('This browser cannot decompress draw.io pages. Export uncompressed XML from the source editor.');
    let binary; try { binary = Uint8Array.from(atob(value.trim()), c => c.charCodeAt(0)); } catch { throw Error('Invalid compressed diagram'); }
    const reader = new Blob([binary]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), chunks = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 25000000) { await reader.cancel(); throw Error('Decompressed document is too large'); } chunks.push(value); }
    return decodeURIComponent(await new Blob(chunks).text());
}
export async function importDrawio(source) {
    if (source.length > 25000000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw Error('Oversized XML or external entities are not supported');
    const parser = new DOMParser(); let xml = parser.parseFromString(source, 'text/xml'); if (xml.querySelector('parsererror')) throw Error('Invalid diagram XML');
    const pages = [...xml.querySelectorAll('diagram')], models = [];
    if (!pages.length && xml.querySelector('mxGraphModel')) models.push(xml);
    for (const page of pages) { if (page.querySelector('mxGraphModel')) models.push(page); else { const decoded = page.textContent.trim().startsWith('<') ? page.textContent : await inflate(page.textContent); if (/<!DOCTYPE|<!ENTITY/i.test(decoded)) throw Error('External entities are not supported'); const doc = parser.parseFromString(decoded, 'text/xml'); if (doc.querySelector('parsererror') || !doc.querySelector('mxGraphModel')) throw Error('Invalid diagram page'); models.push(doc); } }
    if (!models.length) throw Error('No mxGraphModel found');
    const objects = [], warnings = [];
    for (let page = 0; page < models.length; page++) {
        const cells = [...models[page].querySelectorAll('mxCell')], ids = new Map(cells.map(c => [c.id, uid('import')])), cellMap = new Map(cells.map(c => [c.id, c]));
        const offset = (cell, seen = new Set()) => { if (seen.has(cell.id)) throw Error('Cyclic diagram group'); seen.add(cell.id); const geo = cell.querySelector(':scope > mxGeometry'), own = { x: num(geo?.getAttribute('x')), y: num(geo?.getAttribute('y')) }, parent = cellMap.get(cell.getAttribute('parent')); if (parent?.getAttribute('vertex') === '1') { const p = offset(parent, seen); own.x += p.x; own.y += p.y; } return own; };
        for (const cell of cells) {
            const edge = cell.getAttribute('edge') === '1', vertex = cell.getAttribute('vertex') === '1'; if (!edge && !vertex) continue;
            const style = Object.fromEntries((cell.getAttribute('style') || '').split(';').filter(Boolean).map(x => { const i = x.indexOf('='); return i < 0 ? [x, '1'] : [x.slice(0, i), x.slice(i + 1)]; })), geometry = cell.querySelector(':scope > mxGeometry'), p = offset(cell);
            const type = edge ? 'connector' : style.shape === 'image' ? 'image' : style.ellipse ? 'ellipse' : style.rhombus || style.shape === 'rhombus' ? 'diamond' : style.triangle || style.shape === 'triangle' ? 'triangle' : style.text ? 'text' : style.swimlane || style.shape === 'swimlane' ? 'frame' : style.shape === 'note' ? 'sticky' : 'rect';
            const parent = cellMap.get(cell.getAttribute('parent')), label = cell.getAttribute('value') || cell.parentElement?.getAttribute('label') || '', props = { id: ids.get(cell.id), w: Math.max(0, num(geometry?.getAttribute('width'), 160)), h: Math.max(0, num(geometry?.getAttribute('height'), 100)), text: plainHTML(label).slice(0, 40000), fill: color(style.fillColor, '#ffffff'), stroke: color(style.strokeColor), color: color(style.fontColor, '#25283d'), strokeWidth: Math.min(2000, num(style.strokeWidth, 1)), fontSize: Math.min(2000, num(style.fontSize, 16)), rotation: num(style.rotation), opacity: num(style.opacity, 100) / 100, bold: !!(+style.fontStyle & 1), italic: !!(+style.fontStyle & 2), radius: style.rounded === '1' ? 12 : 0, dash: style.dashed === '1', align: ['left', 'right', 'center'].includes(style.align) ? style.align : 'center', z: objects.length };
            if (type === 'image') { let src = style.image ? decodeURIComponent(style.image) : ''; src = src.replace(/^(data:image\/(?:png|jpeg|webp|gif)),/, '$1;base64,'); if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src)) { warnings.push('External or unsupported diagram image omitted; embed a raster image'); continue; } props.src = src; }
            if (parent?.getAttribute('vertex') === '1') props.group = ids.get(parent.id);
            if (edge) { props.route = style.edgeStyle?.includes('orthogonal') ? 'elbow' : style.curved === '1' ? 'curve' : 'straight'; props.arrowEnd = style.endArrow !== 'none'; props.arrowStart = !!style.startArrow && style.startArrow !== 'none';
                if (ids.has(cell.getAttribute('source'))) props.from = { id: ids.get(cell.getAttribute('source')), side: 'auto' }; if (ids.has(cell.getAttribute('target'))) props.to = { id: ids.get(cell.getAttribute('target')), side: 'auto' };
                const a = geometry?.querySelector('mxPoint[as="sourcePoint"]'), b = geometry?.querySelector('mxPoint[as="targetPoint"]'); props.points = [[num(a?.getAttribute('x')), num(a?.getAttribute('y'))], [num(b?.getAttribute('x'), 180), num(b?.getAttribute('y'), 100)]];
                if (geometry?.querySelector('Array[as="points"]')) warnings.push('Manual edge waypoints are converted to automatic routing');
            }
            if (style.shape && !['note','rhombus','triangle','swimlane','rectangle','image'].includes(style.shape)) warnings.push('Custom stencils converted to editable rectangles: ' + style.shape);
            if (style.html === '1') warnings.push('HTML labels imported as safe plain text');
            objects.push(makeObject(type, p.x + page * 1600, p.y, props));
        }
    }
    if (models.length > 1) warnings.push('Multiple pages placed side by side, 1,600 units apart');
    return validateResult(objects, warnings, 'diagrams.net');
}
export function exportDrawio(doc) {
    const warnings = [], cells = ['<mxCell id="0"/><mxCell id="1" parent="0"/>'];
    for (const o of doc.objects()) {
        const edge = o.type === 'connector', shape = ({ ellipse: 'ellipse;', diamond: 'rhombus;', triangle: 'triangle;', frame: 'swimlane;', text: 'text;', sticky: 'shape=note;' })[o.type] || '', fill = o.fill === 'transparent' ? 'none' : o.fill || 'none';
        const styles = `${shape}html=0;fillColor=${fill};strokeColor=${o.stroke === 'transparent' ? 'none' : o.stroke || '#595269'};strokeWidth=${o.strokeWidth || 0};fontColor=${o.color || '#25283d'};fontSize=${o.fontSize || 18};fontStyle=${(o.bold ? 1 : 0) + (o.italic ? 2 : 0)};rounded=${o.radius ? 1 : 0};dashed=${o.dash ? 1 : 0};rotation=${o.rotation || 0};opacity=${(o.opacity ?? 1) * 100};align=${o.align || 'left'};${edge ? `endArrow=${o.arrowEnd ? 'classic' : 'none'};startArrow=${o.arrowStart ? 'classic' : 'none'};${o.route === 'elbow' ? 'edgeStyle=orthogonalEdgeStyle;' : o.route === 'curve' ? 'curved=1;' : ''}` : ''}`;
        const text = o.type === 'table' ? (o.cells || []).map(r => r.join(' | ')).join('\n') : o.text || '';
        let geo = `<mxGeometry x="${o.x || 0}" y="${o.y || 0}" width="${o.w || 0}" height="${o.h || 0}" as="geometry"/>`;
        if (edge) { const points = connectorPoints(o, id => doc.get(id)); geo = `<mxGeometry relative="1" as="geometry"><mxPoint x="${points[0].x}" y="${points[0].y}" as="sourcePoint"/><mxPoint x="${points.at(-1).x}" y="${points.at(-1).y}" as="targetPoint"/></mxGeometry>`; }
        if (o.type === 'image') { cells.push(`<mxCell id="${xmlEscape(o.id)}" value="" style="shape=image;image=${xmlEscape(o.src.replace(';base64,', ','))};" vertex="1" parent="1">${geo}</mxCell>`); continue; }
        if (o.type === 'pen') { warnings.push('Freehand strokes export as editable connected line segments'); const ps = o.points || []; for (let i = 1; i < ps.length; i++) cells.push(`<mxCell id="${xmlEscape(o.id)}_${i}" style="strokeColor=${o.stroke};strokeWidth=${o.strokeWidth};endArrow=none;" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${o.x + ps[i - 1][0]}" y="${o.y + ps[i - 1][1]}" as="sourcePoint"/><mxPoint x="${o.x + ps[i][0]}" y="${o.y + ps[i][1]}" as="targetPoint"/></mxGeometry></mxCell>`); continue; }
        cells.push(`<mxCell id="${xmlEscape(o.id)}" value="${xmlEscape(text)}" style="${xmlEscape(styles)}" ${edge ? 'edge' : 'vertex'}="1" parent="1"${edge && o.from ? ` source="${xmlEscape(o.from.id)}"` : ''}${edge && o.to ? ` target="${xmlEscape(o.to.id)}"` : ''}>${geo}</mxCell>`);
        if (o.richText?.some(r => Object.keys(r.marks || {}).length)) warnings.push('Inline formatting exports as plain text'); if (o.type === 'table' || o.type === 'card') warnings.push('Tables and task cards export as labelled shapes');
    }
    return { data: `<?xml version="1.0" encoding="UTF-8"?><mxfile host="Orivane"><diagram name="${xmlEscape(doc.get('board_meta')?.title || 'Board')}" id="orivane"><mxGraphModel><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`, warnings: [...new Set(warnings)] };
}
export function importMiroREST(data) {
    const items = data.items || data.data; if (!Array.isArray(items) || items.length > 10000) throw Error('Expected exported REST API items');
    const objects = [], warnings = [], ids = new Map(items.map(e => [e.id, uid('import')]));
    for (const item of items) {
        const type = ({ sticky_note: 'sticky', text: 'text', shape: ({ circle: 'ellipse', rhombus: 'diamond', triangle: 'triangle' })[item.data?.shape] || 'rect', card: 'card', frame: 'frame', connector: 'connector' })[item.type];
        if (!type) { warnings.push(`REST item not imported: ${item.type}`); continue; }
        const w = Math.max(1, num(item.geometry?.width, 200)), h = Math.max(1, num(item.geometry?.height, 160)), props = { id: ids.get(item.id), w, h, text: plainHTML(item.data?.content || item.data?.title || item.data?.text || '').slice(0, 40000), fill: color(item.style?.fillColor, type === 'sticky' ? '#fff0a6' : '#ffffff'), color: color(item.style?.color, '#25283d'), stroke: color(item.style?.borderColor), fontSize: Math.min(2000, num(item.style?.fontSize, 18)), rotation: num(item.geometry?.rotation), z: objects.length };
        if (type === 'connector') { props.route = 'elbow'; props.arrowEnd = true; if (ids.has(item.startItem?.id)) props.from = { id: ids.get(item.startItem.id), side: 'auto' }; if (ids.has(item.endItem?.id)) props.to = { id: ids.get(item.endItem.id), side: 'auto' }; }
        objects.push(makeObject(type, num(item.position?.x) - w / 2, num(item.position?.y) - h / 2, props));
    }
    warnings.push('REST interchange is not a proprietary .rtb backup translator. Unsupported items are reported, not silently counted as imported.');
    return validateResult(objects, warnings, 'REST board items');
}
export async function importBoardFile(text, filename = '') {
    if (text.length > 25000000) throw Error('Import is limited to 25 MB');
    if (/\.rtb$/i.test(filename)) throw Error('Proprietary .rtb archives are not supported. Use the configured REST board importer or an open interchange format.');
    if (/^\s*</.test(text)) return importDrawio(text);
    let data; try { data = JSON.parse(text); } catch { throw Error('Invalid board JSON'); }
    if (data.type === 'excalidraw') return importExcalidraw(data);
    if (data.type === 'miro-rest' || Array.isArray(data.items)) return importMiroREST(data);
    throw Error('Choose .excalidraw, .drawio/.xml, or REST item JSON. Use the normal Import command for Orivane documents.');
}
