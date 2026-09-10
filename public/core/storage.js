/** Storage adapter that keeps the editor usable when a browser denies storage.
 * The UI explicitly labels the volatile fallback; it is not a persistence claim.
 */
class VolatileStorage {
    constructor() { this.values = new Map(); this.volatile = true; }
    get length() { return this.values.size; }
    key(index) { return [...this.values.keys()][index] ?? null; }
    getItem(key) { return this.values.get(String(key)) ?? null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
    clear() { this.values.clear(); }
}
function usableStorage(name) {
    try {
        const storage = globalThis[name], key = 'orivane:storage-probe:' + Math.random();
        storage.setItem(key, '1'); storage.removeItem(key); return storage;
    } catch { return new VolatileStorage(); }
}
export const localStore = usableStorage('localStorage');
export const sessionStore = usableStorage('sessionStorage');
export class BoardStorage {
    async open() { try {
        this.db = await new Promise((resolve, reject) => { const req = indexedDB.open('orivane-studio', 1); req.onupgradeneeded = () => { for (const name of ['boards', 'settings', 'outbox', 'versions'])
            if (!req.result.objectStoreNames.contains(name))
                req.result.createObjectStore(name, { keyPath: 'id' }); }; req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        this.mode = 'IndexedDB';
    }
    catch (e) {
        this.mode = localStore.volatile ? 'Memory only' : 'Local storage';
        this.error = e;
    } return this; }
    async get(store, id) { if (!this.db) {
        try {
            return JSON.parse(localStore.getItem(`orivane:${store}:${id}`) || 'null');
        }
        catch {
            return null;
        }
    } return new Promise((resolve, reject) => { const r = this.db.transaction(store).objectStore(store).get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
    async put(store, value) { if (!this.db) {
        localStore.setItem(`orivane:${store}:${value.id}`, JSON.stringify(value));
        return;
    } return new Promise((resolve, reject) => { const tx = this.db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('Storage transaction aborted')); }); }
    async delete(store, id) { if (!this.db) {
        localStore.removeItem(`orivane:${store}:${id}`);
        return;
    } return new Promise((resolve, reject) => { const tx = this.db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
    async all(store) { if (!this.db) {
        return Array.from({length:localStore.length},(_,i)=>localStore.key(i)).filter(k => k.startsWith(`orivane:${store}:`)).map(k => { try {
            return JSON.parse(localStore.getItem(k));
        }
        catch {
            return null;
        } }).filter(Boolean);
    } return new Promise((resolve, reject) => { const r = this.db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
}
