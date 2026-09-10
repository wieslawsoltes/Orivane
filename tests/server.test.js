import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { BoardDocument } from '../public/core/model.js';
import { Collaboration } from '../public/core/collaboration.js';
class MemoryStorage {
    constructor() { this.map = new Map(); }
    async get(store, id) { return structuredClone(this.map.get(store + id)); }
    async put(store, value) { this.map.set(store + value.id, structuredClone(value)); }
}
const wait = async (fn, message = 'condition') => { const end = Date.now() + 6000; while (Date.now() < end) {
    if (await fn())
        return;
    await new Promise(r => setTimeout(r, 25));
} throw Error('Timed out: ' + message); };
async function fixture() {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'orivane-test-'));
    let app = await createApp({ dataDir });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    let base = `http://127.0.0.1:${app.server.address().port}`;
    const doc = new BoardDocument('seed');
    doc.transact([{ id: 'board_meta', props: { type: 'meta', title: 'Test board' } }, { id: 'note', props: { type: 'sticky', x: 10, y: 20, w: 160, h: 160, text: 'Seed', fill: '#fff0a6', $deleted: false } }]);
    const response = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: doc.snapshot() }) });
    assert.equal(response.status, 201);
    const room = await response.json();
    const clients = [];
    const headers = (role = 'editor', actor = 'editor') => ({ 'Authorization': `Bearer ${room[role + 'Token']}`, 'X-Orivane-Actor': actor, 'X-Orivane-Client': clients.find(c => c.doc.actor === actor)?.clientSecret || 'clientsecret________________' + actor, 'Content-Type': 'application/json' });
    const request = (action, role = 'editor', actor = 'editor', data = null) => fetch(`${base}/api/rooms/${room.id}/${action}`, { method: data ? 'POST' : 'GET', headers: headers(role, actor), body: data ? JSON.stringify(data) : undefined });
    const client = async (actor, role = 'editor', storage = new MemoryStorage(), snapshot = null) => { globalThis.location = { protocol: 'http:', origin: base }; const d = new BoardDocument(actor); if (snapshot)
        d.merge(snapshot); const c = new Collaboration(d, storage, 'room:' + room.id, { name: actor, color: '#7755cc' }); c.onStatus = () => { }; c.base = base; clients.push(c); await c.connect(room.id, room[role + 'Token']); await wait(() => c.connected, 'client connection'); return c; };
    return { room, request, headers, client, doc, get base() { return base; }, get app() { return app; }, dataDir, async restart() { for (const c of clients)
            c.destroy(); await app.close(); app = await createApp({ dataDir }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; }, async close() { for (const c of clients)
            c.destroy(); await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
test('HTTP app serves static files with CSP and rejects unknown endpoints', async () => { const f = await fixture(); try {
    const res = await fetch(f.base + '/');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.ok((await res.text()).includes('Orivane'));
    assert.equal((await fetch(f.base + '/api/unknown')).status, 404);
    assert.equal((await fetch(f.base + '/api/rooms', { method: 'POST', headers: { Origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
}
finally {
    await f.close();
} });
test('Capability tokens authorize editors and enforce view-only on server', async () => { const f = await fixture(); try {
    const op = { id: 'op1', actor: 'ed', clock: 2, changes: [{ id: 'note', props: { text: 'Edited' } }] };
    assert.equal((await f.request('ops', 'viewer', 'ed', op)).status, 403);
    assert.equal((await f.request('ops', 'editor', 'ed', op)).status, 200);
    const snapshot = await (await f.request('snapshot', 'viewer', 'viewer')).json(), d = new BoardDocument('check');
    d.merge(snapshot);
    assert.equal(d.get('note').text, 'Edited');
    const bad = await fetch(`${f.base}/api/rooms/${f.room.id}/snapshot`, { headers: { Authorization: 'Bearer ' + 'x'.repeat(43), 'X-Orivane-Actor': 'a' } });
    assert.equal(bad.status, 403);
}
finally {
    await f.close();
} });
test('Two real streaming clients merge concurrent fields and receive presence', async () => { const f = await fixture(); try {
    const a = await f.client('alice'), b = await f.client('bob');
    a.doc.transact([{ id: 'note', props: { x: 125 } }]);
    b.doc.transact([{ id: 'note', props: { text: 'Bob was here' } }]);
    await wait(() => a.doc.get('note').text === 'Bob was here' && b.doc.get('note').x === 125, 'bidirectional collaboration');
    await wait(() => !a.pending.length && !b.pending.length, 'durable acknowledgements');
    assert.equal(a.doc.canonical(), b.doc.canonical());
    a.presence({ cursor: { x: 10, y: 20 }, selection: ['note'], view: { x: 100, y: 120, zoom: .8, cx: 300, cy: 400 } });
    await wait(() => b.peers.has('alice'), 'presence');
    assert.deepEqual(b.peers.get('alice').cursor, { x: 10, y: 20 });
    assert.equal(b.peers.get('alice').view.cx, 300);
}
finally {
    await f.close();
} });
test('Offline edits replay through the durable outbox after reconnect', async () => { const f = await fixture(); try {
    const a = await f.client('alice'), b = await f.client('bob');
    a.connected = false;
    a.abort.abort();
    a.doc.transact([{ id: 'note', props: { x: 555 } }]);
    await wait(() => a.pending.length === 1, 'offline outbox');
    b.doc.transact([{ id: 'note', props: { text: 'Changed while Alice was away' } }]);
    await wait(() => !b.pending.length, 'remote save');
    a.readStream();
    await wait(() => a.connected && a.pending.length === 0 && b.doc.get('note').x === 555, 'reconnect replay');
    assert.equal(a.doc.get('note').text, 'Changed while Alice was away');
    assert.equal(a.doc.canonical(), b.doc.canonical());
}
finally {
    await f.close();
} });
test('Persisted outbox survives a client replacement with the same actor', async () => { const f = await fixture(); try {
    const store = new MemoryStorage(), a = await f.client('alice', 'editor', store);
    a.connected = false;
    a.abort.abort();
    a.doc.transact([{ id: 'note', props: { y: 999 } }]);
    await wait(async () => !!(await store.get('outbox', a.outboxKey))?.ops?.length, 'stored pending operation');
    const snapshot = a.doc.snapshot();
    a.destroy();
    const next = await f.client('alice', 'editor', store, snapshot);
    await wait(() => !next.pending.length, 'replayed persisted operation');
    const d = new BoardDocument('verify');
    d.merge(await (await f.request('snapshot')).json());
    assert.equal(d.get('note').y, 999);
}
finally {
    await f.close();
} });
test('Room snapshots persist across server restart without storing plaintext tokens', async () => { const f = await fixture(); try {
    const op = { id: 'persist', actor: 'ed', clock: 3, changes: [{ id: 'note', props: { text: 'Survives restart' } }] };
    assert.equal((await f.request('ops', 'editor', 'ed', op)).status, 200);
    const file = await readFile(path.join(f.dataDir, f.room.id + '.json'), 'utf8');
    assert.ok(!file.includes(f.room.editorToken));
    assert.ok(!file.includes(f.room.ownerToken));
    await f.restart();
    const d = new BoardDocument('verify');
    d.merge(await (await f.request('snapshot', 'viewer')).json());
    assert.equal(d.get('note').text, 'Survives restart');
}
finally {
    await f.close();
} });
test('Owner rotates invitations; previous editor and viewer tokens are revoked', async () => { const f = await fixture(); try {
    assert.equal((await f.request('invites', 'editor', 'a', {})).status, 403);
    const result = await f.request('invites', 'owner', 'owner', {});
    assert.equal(result.status, 200);
    const fresh = await result.json();
    assert.equal((await f.request('snapshot', 'editor')).status, 403);
    assert.equal((await f.request('snapshot', 'viewer')).status, 403);
    assert.equal((await f.request('snapshot', 'owner')).status, 200);
    const good = await fetch(`${f.base}/api/rooms/${f.room.id}/snapshot`, { headers: { Authorization: `Bearer ${fresh.viewerToken}`, 'X-Orivane-Actor': 'new-viewer' } });
    assert.equal(good.status, 200);
}
finally {
    await f.close();
} });
test('Server rejects actor forgery and invalid geometry without changing board', async () => { const f = await fixture(); try {
    const before = await (await f.request('snapshot')).text();
    assert.equal((await f.request('ops', 'editor', 'alice', { id: 'forged', actor: 'bob', clock: 3, changes: [{ id: 'note', props: { text: 'bad' } }] })).status, 403);
    assert.equal((await f.request('ops', 'editor', 'alice', { id: 'invalid', actor: 'alice', clock: 3, changes: [{ id: 'note', props: { x: -1e12 } }] })).status, 400);
    const after = await (await f.request('snapshot')).text();
    assert.equal(before, after);
}
finally {
    await f.close();
} });
test('Shared workshop timer, vote cap, comments and reactions propagate', async () => { const f = await fixture(); try {
    const a = await f.client('alice'), b = await f.client('bob');
    a.doc.transact([{ id: 'workshop_timer', props: { type: 'session', running: true, endAt: Date.now() + 300000 } }, { id: 'workshop_vote', props: { type: 'session', session: 'ballot1', limit: 1, ended: false } }]);
    await wait(() => b.doc.get('workshop_timer') && b.doc.get('workshop_vote'), 'workshop state');
    a.doc.transact([{ id: 'v1', props: { type: 'vote', target: 'note', session: 'ballot1', authorId: 'alice', $deleted: false } }]);
    await wait(() => b.doc.get('v1'), 'vote propagation');
    const invalid = { id: 'extra-vote', actor: 'alice', clock: a.doc.clock + 1, changes: [{ id: 'v2', props: { type: 'vote', target: 'other', session: 'ballot1', authorId: 'alice', $deleted: false } }] };
    assert.equal((await f.request('ops', 'editor', 'alice', invalid)).status, 400);
    b.doc.transact([{ id: 'comment1', props: { type: 'comment', x: 50, y: 60, text: 'Review this', author: 'Bob', authorId: 'bob', created: Date.now(), resolved: false } }]);
    await wait(() => a.doc.get('comment1'), 'comment');
    let reaction = null;
    b.onReaction = m => reaction = m;
    a.reaction('🎉', { x: 20, y: 30 });
    await wait(() => reaction?.emoji === '🎉', 'reaction');
    assert.equal(reaction.actor, 'alice');
}
finally {
    await f.close();
} });
test('Vote limits apply to a whole transaction and reject duplicate targets', async () => {
    const f = await fixture();
    try {
        const setup = { id: 'voting-setup', actor: 'host', clock: 10, changes: [
                { id: 'workshop_vote', props: { type: 'session', session: 'batch-ballot', limit: 1, ended: false } },
                { id: 'note-two', props: { type: 'sticky', x: 220, y: 20, w: 160, h: 160, text: 'Second target' } }
            ] };
        assert.equal((await f.request('ops', 'owner', 'host', setup)).status, 200);
        const makeVote = (id, target) => ({ id, props: { type: 'vote', authorId: 'alice', session: 'batch-ballot', target, $deleted: false } });
        const batch = { id: 'vote-batch', actor: 'alice', clock: 11, changes: [makeVote('v1', 'note'), makeVote('v2', 'note-two')] };
        const response = await f.request('ops', 'editor', 'alice', batch);
        assert.equal(response.status, 400);
        assert.match(await response.text(), /allowance/);
        const d = new BoardDocument('check');
        d.merge(await (await f.request('snapshot')).json());
        assert.equal(d.get('v1'), null);
        assert.equal(d.get('v2'), null);
        await f.request('ops', 'owner', 'host', { id: 'limit-update', actor: 'host', clock: 12, changes: [{ id: 'workshop_vote', props: { limit: 5 } }] });
        const duplicate = { id: 'duplicate-votes', actor: 'alice', clock: 13, changes: [makeVote('v3', 'note'), makeVote('v4', 'note')] };
        assert.match(await (await f.request('ops', 'editor', 'alice', duplicate)).text(), /one vote/);
    }
    finally {
        await f.close();
    }
});
test('One participant cannot delete or retag another participant’s vote', async () => {
    const f = await fixture();
    try {
        await f.request('ops', 'owner', 'host', { id: 'start-vote', actor: 'host', clock: 5, changes: [{ id: 'workshop_vote', props: { type: 'session', session: 'protected-ballot', limit: 3, ended: false } }] });
        await f.request('ops', 'editor', 'alice', { id: 'alice-vote', actor: 'alice', clock: 6, changes: [{ id: 'protected-vote', props: { type: 'vote', authorId: 'alice', target: 'note', session: 'protected-ballot', $deleted: false } }] });
        for (const props of [{ $deleted: true }, { type: 'text', authorId: 'bob', text: 'Not a vote' }]) {
            const response = await f.request('ops', 'editor', 'bob', { id: 'tamper-' + Object.keys(props)[0].replace('$', ''), actor: 'bob', clock: 7, changes: [{ id: 'protected-vote', props }] });
            assert.equal(response.status, 403);
        }
    }
    finally {
        await f.close();
    }
});
