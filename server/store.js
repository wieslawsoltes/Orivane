import { mkdir, readFile, rename, open, readdir, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const digest = value => createHash('sha256').update(value).digest('hex');
export const failure = (status, message) => Object.assign(Error(message), { status });
const validKey = key => typeof key === 'string' && key.length > 0 && key.length < 400 && !/[\x00-\x1f]/.test(key);
/** Disk snapshots are fsynced and atomically renamed. One API process per
 * directory; use the remote storage service for multi-process deployments. */
export class FileStore {
    constructor(directory) { this.directory = directory; this.locks = new Map(); this.mode = 'fsync + atomic snapshots'; }
    async init() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.lockfile = path.join(this.directory, '.writer.lock');
        const startup = path.join(this.directory, '.writer.startup');
        const owner = { pid: process.pid, host: os.hostname(), token: randomBytes(16).toString('hex') };
        // Serialize lock recovery itself: without this guard two starters could
        // both observe a stale PID and accidentally unlink the new owner's lock.
        let guard;
        try { guard = await open(startup, 'wx', 0o600); }
        catch (e) { if (e.code === 'EEXIST') throw Error('Storage writer startup is already in progress. Inspect .writer.startup before removing an abandoned startup marker.'); throw e; }
        try {
            await guard.writeFile(JSON.stringify(owner)); await guard.sync();
            let prior;
            try { prior = JSON.parse(await readFile(this.lockfile, 'utf8')); }
            catch (e) { if (e.code !== 'ENOENT') throw Error('Storage directory has an unreadable writer lock; inspect it before starting'); }
            if (prior) {
                let alive = true;
                if (prior.host === os.hostname() && Number.isSafeInteger(prior.pid) && prior.pid > 0) {
                    try { process.kill(prior.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
                }
                if (alive) throw Error('Storage directory already has a writer. Use CLUSTER_STORAGE_URL for multiple API processes.');
                await unlink(this.lockfile);
            }
            const handle = await open(this.lockfile, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
            finally { await handle.close(); }
            this.lockToken = owner.token;
            return this;
        } finally { await guard.close(); await unlink(startup); }
    }
    filename(key) { if (!validKey(key)) throw failure(400, 'Invalid storage key'); return path.join(this.directory, /^room:[a-f0-9]{24}$/.test(key) ? key.slice(5) + '.json' : '_' + digest(key) + '.json'); }
    async read(key) {
        try { const raw = JSON.parse(await readFile(this.filename(key), 'utf8')); return raw.__store === 1 ? { version: raw.version, value: raw.value } : { version: 0, value: raw }; }
        catch (e) { if (e.code === 'ENOENT') return { version: 0, value: null }; throw e; }
    }
    async get(key) { return (await this.read(key)).value; }
    async write(key, version, value) {
        const file = this.filename(key), tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
        const handle = await open(tmp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ __store: 1, key, version, value })); await handle.sync(); }
        finally { await handle.close(); }
        try { await rename(tmp, file); const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
        catch (e) { await unlink(tmp).catch(() => {}); throw e; }
    }
    async transaction(key, mutate) {
        const previous = this.locks.get(key) || Promise.resolve(); let release;
        const gate = new Promise(resolve => release = resolve); this.locks.set(key, gate);
        await previous.catch(() => {});
        try {
            const current = await this.read(key), change = await mutate(structuredClone(current.value));
            if (!change || !Object.hasOwn(change, 'value')) throw Error('Storage transaction must return a value');
            try { await this.write(key, current.version + 1, change.value); } catch { throw failure(503, 'Durable storage write failed; no operation was acknowledged'); }
            return { ...change, version: current.version + 1 };
        } finally { release(); if (this.locks.get(key) === gate) this.locks.delete(key); }
    }
    async put(key, value) { return this.transaction(key, () => ({ value })); }
    async keys(prefix = '') {
        const keys = [];
        for (const file of await readdir(this.directory)) if (file.endsWith('.json')) {
            try { const raw = JSON.parse(await readFile(path.join(this.directory, file), 'utf8')), key = raw.__store === 1 ? raw.key : raw.id && `room:${raw.id}`; if (key?.startsWith(prefix) && (raw.__store !== 1 || raw.value !== null)) keys.push(key); }
            catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        return keys;
    }
    async health() { await readdir(this.directory); return { ready: true, mode: this.mode }; }
    async close() { await Promise.all([...this.locks.values()]); if (this.lockToken) { const lock = JSON.parse(await readFile(this.lockfile, 'utf8')); if (lock.token === this.lockToken) await unlink(this.lockfile); this.lockToken = null; } }
}
/** Authenticated conditional HTTP writes. CAS is performed inside SQLite by the
 * storage node, so application workers need no sticky routing or shared memory.
 * A failed/missing acknowledgement never becomes a successful client ack.
 */
export class RemoteStore {
    constructor(url, secret) {
        this.base = new URL(url); this.secret = secret; this.mode = 'network CAS / SQLite WAL';
        if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) throw Error('Invalid cluster storage URL');
        if (!secret || secret.length < 32) throw Error('CLUSTER_SECRET must contain at least 32 characters');
        if (this.base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname) && process.env.CLUSTER_ALLOW_HTTP !== 'true') throw Error('Remote cluster storage requires HTTPS (or explicit private-network CLUSTER_ALLOW_HTTP=true)');
    }
    async init() { await this.health(); return this; }
    async request(route, options = {}) {
        let response; try { response = await fetch(new URL(route, this.base), { ...options, signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json', ...options.headers } }); } catch { throw failure(503, 'Shared storage unavailable; retry without discarding unacknowledged operations'); }
        if (!response.ok) throw failure(response.status, response.status === 409 ? 'Storage conflict' : 'Shared storage unavailable');
        return response.json();
    }
    async read(key) { if (!validKey(key)) throw failure(400, 'Invalid storage key'); return this.request(`/state/${encodeURIComponent(key)}`); }
    async get(key) { return (await this.read(key)).value; }
    async transaction(key, mutate) {
        for (let attempt = 0; attempt < 48; attempt++) {
            const current = await this.read(key), change = await mutate(structuredClone(current.value));
            if (!change || !Object.hasOwn(change, 'value')) throw Error('Storage transaction must return a value');
            try { const saved = await this.request(`/state/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'If-Match': String(current.version) }, body: JSON.stringify({ value: change.value }) }); return { ...change, version: saved.version }; }
            catch (e) { if (e.status !== 409) throw e; await new Promise(r => setTimeout(r, Math.min(attempt * 3, 35) + Math.random() * 8)); }
        }
        throw failure(503, 'Shared storage is busy; retry the unacknowledged operation');
    }
    async put(key, value) { return this.transaction(key, () => ({ value })); }
    async keys(prefix = '') { return (await this.request('/state?prefix=' + encodeURIComponent(prefix))).keys; }
    async health() { return this.request('/health'); }
    async close() {}
}
export async function createStore({ dataDir, storageURL = process.env.CLUSTER_STORAGE_URL, clusterSecret = process.env.CLUSTER_SECRET } = {}) {
    return (storageURL ? new RemoteStore(storageURL, clusterSecret) : new FileStore(dataDir)).init();
}
