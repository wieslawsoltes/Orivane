import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** Shared durable state authority. Storage is not browser-accessible and must
 * live on a private network. SQLite's WAL + synchronous=FULL acknowledges only
 * committed CAS writes. No Redis/PostgreSQL package is required. */
export async function createStorageNode({ filename = process.env.CLUSTER_DB || './data/cluster.sqlite', secret = process.env.CLUSTER_SECRET, maxBytes = 80000000 } = {}) {
    if (typeof secret !== 'string' || secret.length < 32) throw Error('A 32+ character CLUSTER_SECRET is required');
    await mkdir(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(filename);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL, updated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL);');
    const get = db.prepare('SELECT version,value FROM kv WHERE key=?'), put = db.prepare('INSERT INTO kv VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET version=excluded.version,value=excluded.value,updated=excluded.updated'), keys = db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' AND value != 'null' ORDER BY key"), changes = db.prepare('SELECT seq,key,version,at FROM changes WHERE seq>? ORDER BY seq LIMIT 2000'), log = db.prepare('INSERT INTO changes(key,version,at) VALUES (?,?,?)');
    const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    const server = http.createServer(async (req, res) => {
        try {
            const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, '')), expected = Buffer.from(secret);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(res, 403, { error: 'Unauthorized' });
            if (req.headers.origin) return send(res, 403, { error: 'Browser access is not allowed' });
            const u = new URL(req.url, 'http://storage.local');
            if (u.pathname === '/health' && req.method === 'GET') { db.prepare('SELECT 1').get(); return send(res, 200, { ready: true, mode: 'SQLite WAL, synchronous FULL', version: '0.2.0' }); }
            if (u.pathname === '/changes' && req.method === 'GET') return send(res, 200, { changes: changes.all(Math.max(0, Number(u.searchParams.get('after')) || 0)) });
            if (u.pathname === '/state' && req.method === 'GET') return send(res, 200, { keys: keys.all((u.searchParams.get('prefix') || '').replace(/[\\%_]/g, '\\$&') + '%').map(r => r.key) });
            if (!u.pathname.startsWith('/state/')) return send(res, 404, { error: 'Not found' });
            const key = decodeURIComponent(u.pathname.slice(7)); if (!key || key.length > 400 || /[\x00-\x1f]/.test(key)) return send(res, 400, { error: 'Invalid key' });
            if (req.method === 'GET') { const r = get.get(key); return send(res, 200, { version: r?.version || 0, value: r ? JSON.parse(r.value) : null }); }
            if (req.method !== 'PUT') return send(res, 405, { error: 'Method not allowed' });
            const expectedVersion = Number(req.headers['if-match']);
            if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return send(res, 428, { error: 'If-Match revision required' });
            const chunks = []; let size = 0;
            for await (const c of req) { size += c.length; if (size > maxBytes) { send(res, 413, { error: 'State too large' }); return; } chunks.push(c); }
            const input = JSON.parse(Buffer.concat(chunks).toString()); if (!Object.hasOwn(input, 'value')) return send(res, 400, { error: 'Value required' });
            const serialized = JSON.stringify(input.value); let version;
            db.exec('BEGIN IMMEDIATE');
            try {
                const current = get.get(key);
                if ((current?.version || 0) !== expectedVersion) { db.exec('ROLLBACK'); return send(res, 409, { error: 'Conflict' }); }
                version = expectedVersion + 1; const now = Date.now(); put.run(key, version, serialized, now); log.run(key, version, now); db.exec('COMMIT');
            } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
            return send(res, 200, { version });
        } catch (e) { send(res, e instanceof SyntaxError ? 400 : 503, { error: e instanceof SyntaxError ? 'Malformed JSON' : 'Storage operation failed' }); }
    });
    server.requestTimeout = 30000;
    return { server, db, async close() { server.closeIdleConnections(); await new Promise(r => server.close(r)); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const app = await createStorageNode(); const port = +(process.env.STORAGE_PORT || 4174), host = process.env.STORAGE_HOST || '127.0.0.1';
    app.server.listen(port, host, () => console.log(`Orivane shared storage listening on ${host}:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
