import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { failure } from './store.js';
export function privateAddress(address) {
    let a = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (a.startsWith('::ffff:')) { const suffix = a.slice(7); if (suffix.includes('.')) a = suffix; else { const parts = suffix.split(':'); if (parts.length === 2) { const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16); a = `${Math.floor(n / 16777216)}.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`; } } }
    if (isIP(a) === 4) { const [x, y] = a.split('.').map(Number); return x === 0 || x === 10 || x === 127 || x === 169 && y === 254 || x === 172 && y >= 16 && y <= 31 || x === 192 && (y === 168 || y === 0) || x === 100 && y >= 64 && y <= 127 || x >= 224 || x === 198 && [18,19].includes(y); }
    return a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd') || /^fe[89ab]/.test(a) || a.startsWith('ff') || a.startsWith('2001:db8:');
}
/** No redirects; DNS results are validated and pinned for the request. Provider
 * endpoints come from administrator configuration, never arbitrary client URLs. */
export async function requestExternal(input, { method = 'GET', headers = {}, body, maxBytes = 5000000, timeout = 30000, allowPrivate = false } = {}) {
    const url = new URL(input), hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure(400, 'Unsafe provider URL');
    if (url.protocol !== 'https:' && !allowPrivate) throw failure(400, 'Provider endpoints require HTTPS');
    const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
    if (!answers.length || !allowPrivate && answers.some(a => privateAddress(a.address))) throw failure(400, 'Private provider address is not allowed');
    const address = answers[0], content = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, {
            method, headers: { ...headers, ...(content !== null ? { 'Content-Length': Buffer.byteLength(content) } : {}) },
            lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family)
        }, response => {
            let bytes = 0; const chunks = [];
            response.on('data', c => { bytes += c.length; if (bytes > maxBytes) request.destroy(failure(502, 'Provider response is too large')); else chunks.push(c); });
            response.on('end', () => { clearTimeout(timer); const text = Buffer.concat(chunks).toString('utf8'); if (response.statusCode >= 300 && response.statusCode < 400) return reject(failure(502, 'Provider redirect rejected')); resolve({ status: response.statusCode, headers: response.headers, text, bytes: Buffer.concat(chunks), json() { try { return JSON.parse(text); } catch { throw failure(502, 'Provider returned invalid JSON'); } } }); });
            response.on('error', reject);
        });
        const timer = setTimeout(() => request.destroy(failure(504, 'Provider request timed out')), timeout); timer.unref();
        request.on('error', e => { clearTimeout(timer); reject(e); }); if (content !== null) request.write(content); request.end();
    });
}
