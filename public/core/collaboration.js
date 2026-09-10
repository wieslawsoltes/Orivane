import { uid } from './model.js';
/** Live transport: authenticated fetch streaming (SSE) + POST transactions.
 * Complete state handshake on reconnect; idempotent property stamps tolerate
 * duplicate delivery and replay of the durable browser outbox.
 */
export class Collaboration {
    constructor(doc, storage, boardId, profile) { this.doc = doc; this.storage = storage; this.boardId = boardId; this.profile = profile; this.peers = new Map(); this.pending = []; this.role = 'editor'; this.status = 'Local board'; this.alive = true; this.lastPresence = 0; this.base = location.protocol === 'file:' ? '' : location.origin; this.onStatus = () => { }; this.onPresence = () => { }; this.onReaction = () => { }; this.outboxKey = `${boardId}:${doc.actor}`; this.clientSecret = uid('client').replaceAll('-', ''); this.csrf = globalThis.orivaneCSRF || '';  this.unsub = doc.onChange(e => { if (e.source === 'local' && e.op) {
        this.channel?.postMessage({ type: 'op', op: e.op });
        if (this.room) {
            this.pending.push(e.op);
            this.persistPending().then(() => this.flush()).catch(e => this.setStatus(`Outbox error: ${e.message}`));
        }
    } }); }
    async local() { if (typeof BroadcastChannel === 'undefined')
        return; this.channel = new BroadcastChannel(`orivane:${this.boardId}`); this.channel.onmessage = e => { const m = e.data; if (m.actor === this.doc.actor)
        return; try {
        if (m.type === 'op')
            this.doc.apply(m.op);
        if (m.type === 'hello')
            this.channel.postMessage({ type: 'snapshot', snapshot: this.doc.snapshot(), actor: this.doc.actor });
        if (m.type === 'snapshot')
            this.doc.merge(m.snapshot);
        if (m.type === 'presence')
            this.receivePresence(m);
        if (m.type === 'reaction')
            this.onReaction(m);
    }
    catch (err) {
        console.warn('Rejected local message', err);
    } }; this.channel.postMessage({ type: 'hello', actor: this.doc.actor }); this.pruneTimer = setInterval(() => { const now = Date.now(); for (const [id, p] of this.peers)
        if (now - p.received > 16000)
            this.peers.delete(id); this.onPresence(this.peers); }, 5000); }
    setStatus(s) { this.status = s; this.onStatus(s, this.role, this.pending.length); }
    async create(workspaceId = null) { if (!this.base)
        throw Error('Live rooms require the included server. Run npm start and open localhost:4173.'); const res = await fetch(`${this.base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf || globalThis.orivaneCSRF || '' }, body: JSON.stringify({ snapshot: this.doc.snapshot(), workspaceId }) }); if (!res.ok)
        throw Error(res.status === 404 ? 'This static host has no collaboration server. Run the included Node server.' : await res.text()); const room = await res.json(); await this.connect(room.id, room.ownerToken); this.invites = room; return room; }
    headers() { return { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-Orivane-Actor': this.doc.actor, 'X-Orivane-Client': this.clientSecret, 'X-CSRF-Token': globalThis.orivaneCSRF || this.csrf || '' }; }
    async connect(room, token) { this.channel?.close(); this.channel = null; this.room = room; this.token = token; this.role = 'pending'; this.outboxKey = `room:${room}:${this.doc.actor}`; const saved = await this.storage.get('outbox', this.outboxKey); this.clientSecret = saved?.clientSecret || this.clientSecret; this.pending = saved?.ops || []; await this.persistPending(); this.setStatus('Connecting…'); this.readStream(); }
    async readStream() {
        if (!this.alive || !this.room)
            return;
        this.abort?.abort();
        this.abort = new AbortController();
        try {
            const res = await fetch(`${this.base}/api/rooms/${encodeURIComponent(this.room)}/stream`, { headers: this.headers(), signal: this.abort.signal });
            if (!res.ok) {
                if (res.status === 403 || res.status === 404) {
                    this.role = 'denied';
                    this.connected = false;
                    this.setStatus('Room access denied');
                    this.onDenied?.();
                    return;
                }
                throw Error('Connection unavailable');
            }
            const reader = res.body.getReader(), decoder = new TextDecoder();
            let buffer = '';
            while (this.alive) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let end;
                while ((end = buffer.indexOf('\n\n')) >= 0) {
                    const event = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                    if (data)
                        this.message(JSON.parse(data));
                }
                if (buffer.length > 70000000)
                    throw Error('Stream event exceeds limit');
            }
        }
        catch (e) {
            if (e.name === 'AbortError')
                return;
            console.warn('Collaboration reconnect', e.message);
        }
        if (this.alive) {
            this.connected = false;
            this.setStatus(this.pending.length ? 'Offline · changes queued' : 'Reconnecting…');
            this.retry = setTimeout(() => this.readStream(), 1500 + Math.random() * 1500);
        }
    }
    message(m) {
        if (m.type === 'welcome') {
            this.role = m.role;
            this.serverOffset = (m.serverTime || Date.now()) - Date.now();
            this.doc.merge(m.snapshot);
            this.connected = true;
            this.setStatus(this.role === 'viewer' ? 'Live · view only' : 'Live · synced');
            this.onWelcome?.();
            this.flush();
        }
        if (m.type === 'snapshot') { this.doc.merge(m.snapshot); this.serverOffset = (m.serverTime || Date.now()) - Date.now(); }
        if (m.type === 'op') {
            this.doc.apply(m.op);
        }
        if (m.type === 'presence')
            this.receivePresence(m);
        if (m.type === 'leave') {
            this.peers.delete(m.actor);
            this.onPresence(this.peers);
        }
        if (m.type === 'reaction')
            this.onReaction(m);
    }
    receivePresence(m) { if (m.actor === this.doc.actor)
        return; this.peers.set(m.actor, { ...m, received: Date.now() }); this.onPresence(this.peers); }
    async persistPending() { return this.storage.put('outbox', { id: this.outboxKey, ops: this.pending, clientSecret: this.clientSecret }); }
    async flush() { if (this.flushing || !this.connected || !this.pending.length || !this.alive)
        return; this.flushing = true; try {
        while (this.pending.length && this.alive) {
            const op = this.pending[0];
            const res = await fetch(`${this.base}/api/rooms/${this.room}/ops`, { method: 'POST', headers: this.headers(), body: JSON.stringify(op) });
            if (!res.ok) {
                const reason = await res.text();
                if ([400, 401, 403, 409, 413].includes(res.status)) {
                    this.setStatus(`Sync rejected: ${reason}`);
                    this.onRejected?.(reason);
                    break;
                }
                throw Error(reason);
            }
            this.pending.shift();
            await this.persistPending();
            this.setStatus(this.pending.length ? 'Live · syncing…' : 'Live · synced');
        }
    }
    catch (e) {
        this.setStatus('Offline · changes queued');
        this.flushRetry = setTimeout(() => this.flush(), 2500);
    }
    finally {
        this.flushing = false;
    } }
    presence(data = {}) { const now = Date.now(); this.lastData = { ...this.lastData, ...data }; if (now - this.lastPresence < 75)
        return; this.lastPresence = now; const message = { type: 'presence', actor: this.doc.actor, name: this.profile.name, color: this.profile.color, ...this.lastData }; this.channel?.postMessage(message); if (this.connected)
        fetch(`${this.base}/api/rooms/${this.room}/presence`, { method: 'POST', headers: this.headers(), body: JSON.stringify(message) }).catch(() => { }); }
    reaction(emoji, point) { const m = { type: 'reaction', actor: this.doc.actor, emoji, ...point, at: Date.now() }; this.channel?.postMessage(m); this.onReaction(m); if (this.connected)
        fetch(`${this.base}/api/rooms/${this.room}/reaction`, { method: 'POST', headers: this.headers(), body: JSON.stringify(m) }).catch(() => { }); }
    async rotateInvites() { const r = await fetch(`${this.base}/api/rooms/${this.room}/invites`, { method: 'POST', headers: this.headers(), body: '{}' }); if (!r.ok)
        throw Error(await r.text()); const info = await r.json(); this.invites = { ...this.invites, ...info }; return this.invites; }
    destroy() { this.alive = false; this.unsub(); this.channel?.close(); this.abort?.abort(); clearTimeout(this.retry); clearTimeout(this.flushRetry); clearInterval(this.pruneTimer); }
}
