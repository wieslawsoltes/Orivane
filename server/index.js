import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { BoardDocument, validateOperation, validId } from '../public/core/model.js';
import { createStore, failure } from './store.js';
import { IdentityService, sha, appendAudit, verifyAudit } from './identity.js';
import { ProviderService } from './providers.js';
const dirname = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(dirname, '../public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const token = () => randomBytes(32).toString('base64url');
const MAX_ROOM = 65000000;
function documentOf(room) { const doc = new BoardDocument('server'); doc.merge(room.snapshot); return doc; }
export async function createApp(options = {}) {
    const { dataDir = process.env.DATA_DIR || path.resolve(dirname, '../data'), allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [], maxRooms = 1000, pollInterval = 600 } = options;
    const store = await createStore({ ...options, dataDir }); let identity, providers;
    try { identity = new IdentityService(store, options.identity); providers = new ProviderService(store, options.providers); }
    catch (error) { await store.close(); throw error; }
    const rooms = new Map(), rates = new Map(); let stopped = false, polling = false;
    const metrics = { requests: 0, operations: 0, rejected: 0, streams: 0, storageFailures: 0, started: Date.now() };
    function send(res, status, data) { if (res.writableEnded || res.destroyed) return; res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); }
    async function body(req, max = 8000000) { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > max) throw failure(413, 'Request exceeds size limit'); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw failure(400, 'Invalid JSON'); } }
    function rate(key, limit = 200, period = 10000) { const now = Date.now(); let r = rates.get(key); if (!r || now - r.at > period) { r = { at: now, n: 0 }; rates.set(key, r); } if (++r.n > limit) throw failure(429, 'Rate limit reached; retry shortly'); }
    function originOK(req) { const o = req.headers.origin; return !o || o === `http://${req.headers.host}` || o === `https://${req.headers.host}` || allowedOrigins.includes(o); }
    function live(id) { if (!rooms.has(id)) rooms.set(id, { id, clients: new Map(), presence: new Map(), revision: -1, presenceVersion: -1 }); return rooms.get(id); }
    function broadcast(room, message) { const event = `data: ${JSON.stringify(message)}\n\n`; for (const [actor, c] of room.clients) { if (c.res.destroyed || c.res.writableLength > MAX_ROOM + 1000000) { c.res.destroy(); room.clients.delete(actor); } else c.res.write(event); } }
    async function role(req, raw, ctx) { return identity.role(raw, ctx, (req.headers.authorization || '').replace(/^Bearer /, '')); }
    function claim(room, req, ctx, actor) {
        const secret = req.headers['x-orivane-client']; if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{24,100}$/.test(secret)) throw failure(400, 'A persistent X-Orivane-Client secret is required');
        room.actorClaims ||= {}; const fingerprint = sha(secret), prior = room.actorClaims[actor];
        if (prior && (prior.fingerprint !== fingerprint || prior.userId && prior.userId !== ctx?.user?.id)) throw failure(409, 'Actor is bound to another client. Open this board in a new tab.');
        if (!prior && Object.keys(room.actorClaims).length >= 10000) throw failure(413, 'Participant identity capacity reached');
        room.actorClaims[actor] = { fingerprint, userId: ctx?.user?.id || prior?.userId || null };
    }
    function guardVotes(doc, op, actor, room, ctx, currentRole) {
        const identityKey = id => room.actorClaims?.[id]?.userId || id, voter = identityKey(actor);
        const staged = new Map(doc.all().filter(v => v.type === 'vote' && identityKey(v.authorId) === voter).map(v => [v.id, v]));
        for (const change of op.changes) {
            const prior = doc.get(change.id, true), type = change.props.type || prior?.type;
            if (room.workspaceId && ['workshop_vote', 'workshop_timer'].includes(change.id) && currentRole !== 'owner') throw failure(403, 'Workspace workshop controls require an owner or administrator');
            if (['chat', 'comment', 'vote'].includes(type) && change.props.authorId && change.props.authorId !== actor) throw failure(403, 'Author identity must match this client');
            if (type === 'chat' && prior && prior.authorId !== actor && currentRole !== 'owner') throw failure(403, 'Only the author can edit a message');
            if (type === 'vote' || prior?.type === 'vote') {
                const o = { ...prior, ...change.props, id: change.id };
                if (o.authorId !== actor || prior && prior.authorId !== actor) throw failure(403, 'Votes must belong to this participant');
                const session = doc.get('workshop_vote'); if (!session || session.ended || o.session !== session.session) throw failure(400, 'Voting session is not active');
                if (!o.$deleted && type === 'vote') { const target = doc.get(o.target); if (!target || ['meta', 'session', 'chat', 'comment', 'vote'].includes(target.type)) throw failure(400, 'Vote target is not a board object'); staged.set(change.id, o); } else staged.delete(change.id);
            }
        }
        const voting = doc.get('workshop_vote'), active = [...staged.values()].filter(v => v.session === voting?.session);
        if (active.length > (voting?.limit || 5)) throw failure(400, 'Vote allowance exhausted');
        if (new Set(active.map(v => v.target)).size !== active.length) throw failure(400, 'Only one vote per participant per object is allowed');
    }
    async function activeAuthorization(cache, raw) {
        for (const [actor, client] of cache.clients) {
            try { const ctx = await identity.context(client.req), currentRole = raw && await role(client.req, raw, ctx); if (!currentRole || currentRole !== client.role) { client.res.end(); cache.clients.delete(actor); } }
            catch { client.res.end(); cache.clients.delete(actor); }
        }
    }
    async function poll() {
        if (polling || stopped) return; polling = true;
        try { for (const cache of rooms.values()) {
            if (!cache.clients.size) continue;
            const record = await store.read('room:' + cache.id), raw = record.value;
            await activeAuthorization(cache, raw);
            if (!raw || raw.deleted) { for (const c of cache.clients.values()) c.res.end(); cache.clients.clear(); continue; }
            if (cache.revision !== (raw.revision || 0)) { cache.revision = raw.revision || 0; broadcast(cache, { type: 'snapshot', snapshot: raw.snapshot, serverTime: Date.now() }); }
            const state = await store.read('presence:' + cache.id), now = Date.now();
            if (state.version !== cache.presenceVersion) {
                cache.presenceVersion = state.version;
                const next = new Map(Object.entries(state.value?.peers || {}).filter(([, p]) => now - p.at < 25000));
                for (const p of next.values()) if (cache.presence.get(p.actor)?.at !== p.at) broadcast(cache, p);
                for (const actor of cache.presence.keys()) if (!next.has(actor)) broadcast(cache, { type: 'leave', actor });
                cache.presence = next;
                for (const event of state.value?.events || []) if (!cache.seenEvents?.has(event.id) && now - event.at < 5000) { broadcast(cache, event); (cache.seenEvents ||= new Set()).add(event.id); }
                if (cache.seenEvents?.size > 1000) cache.seenEvents.clear();
            }
            for (const [actor, p] of cache.presence) if (now - p.at >= 25000) { cache.presence.delete(actor); broadcast(cache, { type: 'leave', actor }); }
        } } catch (e) { metrics.storageFailures++; if (!stopped) console.warn('Room synchronization temporarily unavailable:', e.message); }
        finally { polling = false; }
    }
    const server = http.createServer(async (req, res) => {
        metrics.requests++;
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        try {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`), p = url.pathname;
            if (p.startsWith('/api/') || p.startsWith('/scim/')) { res.setHeader('Cache-Control', 'no-store'); if (!originOK(req)) throw failure(403, 'Origin not allowed'); rate(req.socket.remoteAddress + ':all', 2400); }
            if (p === '/api/health') return send(res, 200, { service: 'Orivane', version: '0.2.0', transport: 'SSE + transactional HTTP', persistence: store.mode, accounts: true, richText: 'RGA / character registers' });
            if (p === '/api/ready') { const health = await store.health(); return send(res, health.ready ? 200 : 503, health); }
            if (p === '/api/metrics') { if (!process.env.METRICS_TOKEN || req.headers.authorization !== 'Bearer ' + process.env.METRICS_TOKEN) throw failure(403, 'Metrics authorization required'); return send(res, 200, { ...metrics, workersLocalRooms: rooms.size, currentStreams: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0), uptimeSeconds: (Date.now() - metrics.started) / 1000 }); }
            if (p.startsWith('/scim/v2')) return await identity.scim(req, res, url, { body, send: (r, status, data) => { r.setHeader('Content-Type', 'application/scim+json'); r.writeHead(status); r.end(JSON.stringify(data)); } });
            const ctx = p.startsWith('/api/') ? await identity.context(req) : null;
            if (await identity.handle(req, res, url, ctx, { body, send })) return;
            if (ctx && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) identity.csrf(req, ctx);
            if (p === '/api/providers' && req.method === 'GET') { identity.requireUser(ctx); return send(res, 200, providers.status()); }
            const boardList = p.match(/^\/api\/workspaces\/([\w-]+)\/boards$/);
            if (boardList && req.method === 'GET') { await identity.workspace(boardList[1], ctx); const boards = []; for (const key of await store.keys('room:')) { const room = await store.get(key); if (room && !room.deleted && room.workspaceId === boardList[1] && await role(req, room, ctx)) boards.push({ id: room.id, title: documentOf(room).get('board_meta')?.title || 'Untitled board', updated: room.updated, created: room.created, ownerId: room.ownerId }); } return send(res, 200, { boards }); }
            if (p === '/api/rooms' && req.method === 'POST') {
                rate(req.socket.remoteAddress + ':create', 30, 3600000);
                if ((await store.keys('room:')).length >= maxRooms) throw failure(503, 'Room capacity reached');
                if (process.env.ALLOW_GUEST_ROOMS === 'false') identity.requireUser(ctx);
                const input = await body(req, MAX_ROOM), doc = new BoardDocument('server'); doc.merge(input.snapshot);
                if (input.workspaceId) { const space = await identity.workspace(input.workspaceId, ctx); if (space.role === 'viewer') throw failure(403, 'Viewers cannot create boards'); }
                const id = randomBytes(12).toString('hex'), ownerToken = token(), editorToken = token(), viewerToken = token();
                const raw = { id, hashes: { owner: sha(ownerToken), editor: sha(editorToken), viewer: sha(viewerToken) }, snapshot: doc.snapshot(), created: Date.now(), updated: Date.now(), revision: 1, ownerId: ctx?.user?.id || null, workspaceId: input.workspaceId || null, acl: {}, actorClaims: {}, opStamps: {} };
                appendAudit(raw, ctx?.user?.id || 'guest', 'room.created'); await store.put('room:' + id, raw);
                return send(res, 201, { id, ownerToken, editorToken, viewerToken, workspaceId: raw.workspaceId });
            }
            const match = p.match(/^\/api\/rooms\/([a-f0-9]{24})\/(stream|ops|presence|reaction|invites|snapshot|audit|acl|versions|restore|ai|integrations|webhooks|delete)$/);
            if (match) {
                const [, id, action] = match, key = 'room:' + id, raw = await store.get(key);
                if (!raw || raw.deleted) throw failure(404, 'Room not found');
                const currentRole = await role(req, raw, ctx); if (!currentRole) throw failure(403, 'Room access denied or invitation revoked');
                const actor = req.headers['x-orivane-actor']; if (!validId(actor)) throw failure(400, 'A valid actor ID is required');
                const cache = live(id);
                if (action === 'snapshot' && req.method === 'GET') return send(res, 200, raw.snapshot);
                if (action === 'audit' && req.method === 'GET') { if (currentRole !== 'owner') throw failure(403, 'Owner required'); return send(res, 200, { events: raw.audit || [], anchor: raw.auditAnchor, valid: verifyAudit(raw.audit || [], raw.auditAnchor) }); }
                if (action === 'versions' && req.method === 'GET') return send(res, 200, { versions: raw.versions || [] });
                if (action === 'webhooks' && req.method === 'GET') { if (currentRole !== 'owner') throw failure(403, 'Owner required'); const jobs = []; for (const k of await store.keys('hook:')) { const j = await store.get(k); if (j?.room === id) jobs.push({ id: j.id, state: j.state, attempts: j.attempts, status: j.status, created: j.created }); } return send(res, 200, { jobs }); }
                if (action === 'stream' && req.method === 'GET') {
                    if (cache.clients.size >= 100 && !cache.clients.has(actor)) throw failure(503, 'Room participant limit reached');
                    await store.transaction(key, async room => { if (!room || room.deleted || !await role(req, room, ctx)) throw failure(403, 'Room access revoked'); claim(room, req, ctx, actor); return { value: room }; });
                    cache.clients.get(actor)?.res.end();
                    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
                    res.write(`data: ${JSON.stringify({ type: 'welcome', role: currentRole, serverTime: Date.now(), snapshot: raw.snapshot, user: ctx?.user ? { id: ctx.user.id, name: ctx.user.name } : null })}\n\n`);
                    for (const data of Object.values((await store.get('presence:' + id))?.peers || {})) if (Date.now() - data.at < 25000) res.write(`data: ${JSON.stringify(data)}\n\n`);
                    const client = { res, role: currentRole, req }; cache.clients.set(actor, client); metrics.streams++;
                    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
                    req.on('close', () => { clearInterval(heartbeat); if (cache.clients.get(actor) === client) { cache.clients.delete(actor); cache.presence.delete(actor); broadcast(cache, { type: 'leave', actor }); /* shared presence expires: do not erase a replacement stream on another worker */ } }); return;
                }
                if (req.method !== 'POST') throw failure(405, 'Method not allowed');
                if (currentRole === 'viewer' && !['presence', 'reaction'].includes(action)) throw failure(403, 'This board is view-only');
                if (action === 'ops') {
                    rate(id + actor + ':ops', 300); const op = await body(req); validateOperation(op);
                    if (op.actor !== actor) throw failure(403, 'Actor mismatch');
                    const result = await store.transaction(key, async room => {
                        const freshRole = room && await role(req, room, ctx); if (!freshRole || freshRole === 'viewer' || room.deleted) throw failure(403, 'Editing permission revoked');
                        claim(room, req, ctx, actor); const doc = documentOf(room);
                        if (op.clock > doc.clock + 1000000) throw failure(400, 'Operation clock too far ahead');
                        room.opStamps ||= {}; const stampKey = `${op.actor}:${op.clock}`, fingerprint = sha(JSON.stringify(op)), prior = room.opStamps[stampKey];
                        if (prior && prior !== fingerprint) throw failure(409, 'Operation stamp was reused for different data');
                        if (prior) return { value: room, result: { ack: op.id, clock: doc.clock, duplicate: true } };
                        if (doc.records.size + op.changes.filter(c => !doc.records.has(c.id)).length > 100000) throw failure(413, 'Board object limit reached');
                        guardVotes(doc, op, actor, room, ctx, freshRole);
                        for (const t of op.text || []) { const target = doc.get(t.id); if (!target) throw failure(400, 'Text target does not exist'); if (target.type === 'chat' && target.authorId !== actor && freshRole !== 'owner') throw failure(403, 'Only the author can edit a message'); }
                        doc.apply(op); room.snapshot = doc.snapshot(); room.opStamps[stampKey] = fingerprint;
                        if (Object.keys(room.opStamps).length > 100000) throw failure(413, 'Operation journal limit reached; fork or archive this board');
                        room.updated = Date.now(); room.revision = (room.revision || 0) + 1;
                        appendAudit(room, ctx?.user?.id || actor, 'board.edit', { operation: op.id, objects: op.changes.length, textFields: op.text?.length || 0 });
                        if (Buffer.byteLength(JSON.stringify(room)) > MAX_ROOM) throw failure(413, 'Board storage limit exceeded');
                        // Outgoing notifications are part of this commit. The dispatcher creates deterministic jobs.
                        if (providers.status().webhook.configured) { room.hookOutbox ||= []; room.hookOutbox.push({ id: sha(op.id + ':' + id), event: { type: 'board.updated', operation: op.id, actor, revision: room.revision }, created: Date.now() }); }
                        return { value: room, result: { ack: op.id, clock: doc.clock } };
                    });
                    metrics.operations++; const previousRevision = cache.revision; cache.revision = result.value.revision || 0; if (previousRevision !== cache.revision - 1) broadcast(cache, { type: 'snapshot', snapshot: result.value.snapshot, serverTime: Date.now() }); else broadcast(cache, { type: 'op', op });
                    return send(res, 200, result.result);
                }
                if (action === 'presence' || action === 'reaction') {
                    rate(id + actor + ':' + action, action === 'presence' ? 240 : 20);
                    claim(raw, req, ctx, actor); const input = await body(req, 25000), finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e9;
                    let data;
                    if (action === 'presence') {
                        data = { type: 'presence', actor, userId: ctx?.user?.id || null, verified: !!ctx?.user, name: String(ctx?.user?.name || input.name || 'Guest').slice(0, 50), color: /^#[a-f0-9]{6}$/i.test(input.color) ? input.color : '#7656d9', selection: Array.isArray(input.selection) ? input.selection.filter(validId).slice(0, 100) : [], at: Date.now(), presenting: !!input.presenting };
                        if (input.cursor && finite(input.cursor.x) && finite(input.cursor.y)) data.cursor = { x: input.cursor.x, y: input.cursor.y };
                        if (input.view && finite(input.view.x) && finite(input.view.y) && finite(input.view.zoom) && input.view.zoom > 0) { data.view = { x: input.view.x, y: input.view.y, zoom: input.view.zoom }; if (finite(input.view.cx) && finite(input.view.cy)) Object.assign(data.view, { cx: input.view.cx, cy: input.view.cy }); }
                        if (Array.isArray(input.ghost)) data.ghost = input.ghost.slice(0, 50).filter(o => ['x', 'y', 'w', 'h'].every(k => finite(o[k]))).map(o => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
                        if (input.laser && finite(input.laser.x) && finite(input.laser.y)) data.laser = { x: input.laser.x, y: input.laser.y };
                    } else { if (!['❤️', '👏', '🎉', '👍', '🔥', '💡'].includes(input.emoji) || ![input.x, input.y].every(finite)) throw failure(400, 'Invalid reaction'); data = { id: token().slice(0, 24), type: 'reaction', actor, emoji: input.emoji, x: input.x, y: input.y, at: Date.now() }; }
                    await store.transaction('presence:' + id, state => { state ||= { peers: {}, events: [] }; const now = Date.now(); for (const [a, p] of Object.entries(state.peers)) if (now - p.at > 30000) delete state.peers[a]; state.events = state.events.filter(e => now - e.at < 5000); if (action === 'presence') state.peers[actor] = data; else state.events.push(data); return { value: state }; });
                    if (action === 'presence') cache.presence.set(actor, data); else (cache.seenEvents ||= new Set()).add(data.id); broadcast(cache, data); return send(res, 200, { ok: true });
                }
                if (action === 'ai' || action === 'integrations') {
                    identity.requireUser(ctx); await identity.limit(ctx.user.id + ':providers', 30, 60000); const input = await body(req, 1000000);
                    if (action === 'ai') return send(res, 200, await providers.ai(input));
                    const { provider, action: task } = input; const run = () => providers.integration(provider, task, input);
                    const output = task === 'import' ? await run() : await providers.once(ctx.user.id, req.headers['idempotency-key'], input, run);
                    await store.transaction(key, room => { appendAudit(room, ctx.user.id, 'integration.' + task, { provider }); return { value: room }; }); return send(res, 200, output);
                }
                if (currentRole !== 'owner') throw failure(403, 'Only the room owner can perform this action');
                const input = await body(req, 100000);
                if (action === 'invites') {
                    const editorToken = token(), viewerToken = token(), ownerToken = input.rotateOwner ? token() : null;
                    await store.transaction(key, async room => { if (await role(req, room, ctx) !== 'owner') throw failure(403, 'Ownership revoked'); room.hashes.editor = sha(editorToken); room.hashes.viewer = sha(viewerToken); if (ownerToken) room.hashes.owner = sha(ownerToken); appendAudit(room, ctx?.user?.id || actor, 'invites.rotated', { owner: !!ownerToken }); return { value: room }; });
                    for (const c of cache.clients.values()) if (c.role !== 'owner' || ownerToken) c.res.end(); return send(res, 200, { id, editorToken, viewerToken, ...(ownerToken ? { ownerToken } : {}) });
                }
                if (action === 'acl') {
                    if (!raw.workspaceId || !validId(input.userId) || !['editor', 'viewer', 'none', 'inherit'].includes(input.role)) throw failure(400, 'Workspace user and editor/viewer/none/inherit role required');
                    const space = await identity.workspace(raw.workspaceId, ctx, true); if (!space.workspace.members[input.userId]) throw failure(400, 'User is not a workspace member');
                    await store.transaction(key, async room => { if (await role(req, room, ctx) !== 'owner') throw failure(403, 'Ownership revoked'); room.acl ||= {}; if (input.role === 'inherit') delete room.acl[input.userId]; else room.acl[input.userId] = input.role; appendAudit(room, ctx.user.id, 'board.access', input); return { value: room }; }); await poll(); return send(res, 200, { ok: true });
                }
                if (action === 'versions') {
                    const version = token().slice(0, 24), item = { id: version, name: String(input.name || 'Named version').slice(0, 100), at: Date.now(), author: ctx?.user?.name || actor };
                    await store.put(`version:${id}:${version}`, raw.snapshot); await store.transaction(key, async room => { if (await role(req, room, ctx) !== 'owner') throw failure(403, 'Ownership revoked'); room.versions = [...(room.versions || []), item]; if (room.versions.length > 100) throw failure(413, 'Limit of 100 named versions reached'); appendAudit(room, ctx?.user?.id || actor, 'version.saved', { version }); return { value: room }; }); return send(res, 201, item);
                }
                if (action === 'restore') {
                    if (!raw.versions?.some(v => v.id === input.version)) throw failure(404, 'Version not found'); const snapshot = await store.get(`version:${id}:${input.version}`), target = new BoardDocument('restore'); target.merge(snapshot);
                    const result = await store.transaction(key, async room => { if (await role(req, room, ctx) !== 'owner') throw failure(403, 'Ownership revoked'); const doc = documentOf(room); doc.actor = 'restore_' + randomBytes(8).toString('hex'); const changes = doc.all().filter(o => !target.get(o.id)).map(o => ({ id: o.id, props: { $deleted: true } }));
                        for (const object of target.all()) { const { id, ...props } = object; changes.push({ id, props: { ...props, $deleted: false } }); }
                        const op = doc.make(changes); if (op) doc.apply(op); room.snapshot = doc.snapshot(); room.revision = (room.revision || 0) + 1; room.updated = Date.now(); appendAudit(room, ctx?.user?.id || actor, 'version.restored', { version: input.version }); return { value: room }; });
                    broadcast(cache, { type: 'snapshot', snapshot: result.value.snapshot }); cache.revision = result.value.revision; return send(res, 200, { restored: input.version });
                }
                if (action === 'delete') { if (input.confirm !== true) throw failure(400, 'Explicit confirmation required'); await store.transaction(key, async room => { if (await role(req, room, ctx) !== 'owner') throw failure(403, 'Ownership revoked'); room.deleted = Date.now(); room.snapshot = null; room.hashes = {}; room.actorClaims = {}; room.opStamps = {}; appendAudit(room, ctx?.user?.id || actor, 'board.deleted'); return { value: room }; }); for (const c of cache.clients.values()) c.res.end(); for (const v of raw.versions || []) await store.put(`version:${id}:${v.id}`, null); await store.put('presence:' + id, null); return send(res, 200, { deleted: true }); }
            }
            if (p.startsWith('/api/')) throw failure(404, 'API route not found');
            if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'Method not allowed');
            const filename = path.resolve(root, '.' + decodeURIComponent(p === '/' ? '/index.html' : p)); if (!filename.startsWith(root + path.sep)) throw failure(403, 'Access denied');
            const info = await stat(filename); if (!info.isFile()) throw failure(404, 'Not found'); const content = await readFile(filename);
            res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': content.length }); res.end(req.method === 'HEAD' ? undefined : content);
        } catch (e) { metrics.rejected++; const status = e.code === 'ENOENT' ? 404 : e.status || 400; if (status >= 500) console.warn('Request failed:', e.message); if (req.url?.startsWith('/scim/')) { res.writeHead(status, { 'Content-Type': 'application/scim+json' }); res.end(JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(status), detail: e.message || 'Request rejected' })); } else send(res, status, e.code === 'ENOENT' ? 'Not found' : e.message || 'Request rejected'); }
    });
    // Commit-local outbox: deterministic IDs survive crashes between enqueue and dequeue.
    let pumping = false;
    async function dispatchHooks() {
        if (pumping || stopped || !providers.status().webhook.configured) return; pumping = true;
        try { for (const key of await store.keys('room:')) { const raw = await store.get(key); for (const event of raw?.hookOutbox || []) { await store.transaction('hook:' + event.id, old => ({ value: old || { ...event, room: raw.id, state: 'queued', attempts: 0, next: Date.now() } })); await store.transaction(key, room => { room.hookOutbox = (room.hookOutbox || []).filter(e => e.id !== event.id); return { value: room }; }); } } await providers.pump(); } catch (e) { console.warn('Webhook dispatch:', e.message); } finally { pumping = false; }
    }
    const interval = setInterval(poll, pollInterval); interval.unref(); const hookTimer = setInterval(dispatchHooks, 2000); hookTimer.unref();
    const cleanup = setInterval(() => { const now = Date.now(); for (const [k, v] of rates) if (now - v.at > 3600000) rates.delete(k); for (const [id, room] of rooms) if (!room.clients.size) rooms.delete(id); }, 60000); cleanup.unref();
    return { server, rooms, store, identity, providers, poll, dispatchHooks, async close() { stopped = true; clearInterval(interval); clearInterval(hookTimer); clearInterval(cleanup); for (const r of rooms.values()) for (const c of r.clients.values()) c.res.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); while (polling || pumping) await new Promise(r => setTimeout(r, 10)); await store.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const app = await createApp(), port = Number(process.env.PORT || 4173), host = process.env.HOST || '127.0.0.1'; app.server.listen(port, host, () => console.log(`Orivane 0.2 listening on http://${host}:${app.server.address().port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
