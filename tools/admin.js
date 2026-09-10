/** Host-administrator operations; no unauthenticated recovery endpoint.
 * Store copies/migrations require the exclusive local writer lock. */
import { DatabaseSync } from 'node:sqlite';
import { mkdir, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore, RemoteStore } from '../server/store.js';
import { passwordHash, appendAudit } from '../server/identity.js';
export async function backupSQLite(source, destination) {
    source = path.resolve(source); destination = path.resolve(destination);
    if (source === destination) throw Error('Backup path must differ from the source');
    await stat(source); try { await stat(destination); throw Error('Refusing to overwrite a backup'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(source, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout=10000'); db.prepare('VACUUM INTO ?').run(destination); const result = new DatabaseSync(destination, { readOnly: true }); try { if (result.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Backup integrity check failed'); } finally { result.close(); } await chmod(destination, 0o600); }
    finally { db.close(); }
    return { source, destination, bytes: (await stat(destination)).size, integrity: 'ok' };
}
export async function copyStore(sourceDirectory, destinationDirectory) {
    const source = await new FileStore(path.resolve(sourceDirectory)).init();
    try {
        await mkdir(path.dirname(path.resolve(destinationDirectory)), { recursive: true, mode: 0o700 });
        await mkdir(path.resolve(destinationDirectory), { mode: 0o700 });
        const destination = await new FileStore(path.resolve(destinationDirectory)).init();
        try { const keys = await source.keys(); for (const key of keys) await destination.put(key, await source.get(key)); return { keys: keys.length, destination: path.resolve(destinationDirectory) }; }
        finally { await destination.close(); }
    } finally { await source.close(); }
}
export async function migrateStore(sourceDirectory, storageURL, secret) {
    const source = await new FileStore(path.resolve(sourceDirectory)).init(); let destination;
    try {
        destination = await new RemoteStore(storageURL, secret).init();
        const keys = await source.keys(), existing = new Set(await destination.keys());
        if (keys.some(key => existing.has(key))) throw Error('Target contains matching keys. Restore/migrate into an empty destination.');
        for (const key of keys) { const value = await source.get(key); await destination.transaction(key, prior => { if (prior !== null) throw Error('Destination key appeared during migration'); return { value }; }); }
        return { migratedKeys: keys.length, target: storageURL };
    } finally { await source.close(); await destination?.close(); }
}
export async function resetPassword(store, email, password) {
    const hash = await passwordHash(password);
    const result = await store.transaction('identity', data => { const user = Object.values(data?.users || {}).find(u => u.email === email.toLowerCase() && u.provider === 'password'); if (!user) throw Error('Password account not found'); user.password = hash; user.sessionVersion = (user.sessionVersion || 0) + 1; appendAudit(data, 'host-administrator', 'account.password-recovered', { userId: user.id }); return { value: data, result: { userId: user.id, sessionsRevoked: true } }; });
    return result.result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [command, first, second] = process.argv.slice(2);
    try {
        let result;
        if (command === 'backup-sqlite' && first && second) result = await backupSQLite(first, second);
        else if (command === 'backup-files' && first && second) result = await copyStore(first, second);
        else if (command === 'migrate' && first && process.env.CLUSTER_STORAGE_URL) result = await migrateStore(first, process.env.CLUSTER_STORAGE_URL, process.env.CLUSTER_SECRET);
        else if (command === 'reset-password' && first && process.env.ORIVANE_RECOVERY_PASSWORD) { const store = await (process.env.CLUSTER_STORAGE_URL ? new RemoteStore(process.env.CLUSTER_STORAGE_URL, process.env.CLUSTER_SECRET) : new FileStore(process.env.DATA_DIR || './data')).init(); try { result = await resetPassword(store, first, process.env.ORIVANE_RECOVERY_PASSWORD); } finally { await store.close(); } }
        else throw Error('Usage: node tools/admin.js backup-sqlite <source.sqlite> <new-backup.sqlite> | backup-files <stopped-data-dir> <new-directory> | migrate <stopped-data-dir> [CLUSTER_STORAGE_URL/CLUSTER_SECRET] | reset-password <email> [ORIVANE_RECOVERY_PASSWORD in environment]');
        console.log(JSON.stringify(result, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
