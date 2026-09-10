import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual, createPublicKey, verify as verifySignature, constants } from 'node:crypto';
import { promisify } from 'node:util';
import { uid, validId } from '../public/core/model.js';
import { failure } from './store.js';
import { requestExternal } from './network.js';
const scrypt = promisify(scryptCallback), randomToken = () => randomBytes(32).toString('base64url');
export const sha = value => createHash('sha256').update(value).digest('hex');
export const equalSecret = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); };
const cleanEmail = v => { if (typeof v !== 'string' || v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw failure(400, 'A valid email address is required'); return v.trim().toLowerCase(); };
const cleanName = v => String(v || '').trim().slice(0, 100);
const state = value => value || { users: {}, spaces: {}, invites: {}, groups: {}, audit: [] };
const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, active: u.active, provider: u.provider || 'password', emailVerified: !!u.emailVerified });
const cookieValue = (req, name) => { for (const item of (req.headers.cookie || '').split(';')) { const [key, ...v] = item.trim().split('='); if (key === name) return v.join('='); } return ''; };
export function appendAudit(target, actor, action, details = {}) {
    target.audit ||= [];
    const previous = target.audit.at(-1)?.hash || target.auditAnchor || '0'.repeat(64), event = { id: uid('event'), at: Date.now(), actor: actor || 'guest', action, details, previous };
    event.hash = sha(JSON.stringify(event)); target.audit.push(event);
    const cutoff = Date.now() - Math.max(7, Math.min(3650, target.retentionDays || 365)) * 86400000;
    let expired = 0; while (expired < target.audit.length && target.audit[expired].at < cutoff) expired++;
    if (expired) { const removed = target.audit.splice(0, expired); target.auditAnchor = removed.at(-1).hash; }
    if (target.audit.length > 10000) { const removed = target.audit.splice(0, target.audit.length - 10000); target.auditAnchor = removed.at(-1).hash; }
    return event;
}
export function verifyAudit(events, anchor = '0'.repeat(64)) { let previous = anchor; for (const entry of events) { const { hash, ...data } = entry; if (data.previous !== previous || sha(JSON.stringify(data)) !== hash) return false; previous = hash; } return true; }
export async function passwordHash(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw failure(400, 'Use a password between 12 and 1024 characters');
    const salt = randomBytes(16).toString('hex'), derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { algorithm: 'scrypt', salt, hash: derived.toString('hex') };
}
export async function checkPassword(password, stored) {
    if (typeof password !== 'string' || password.length > 1024) return false;
    const salt = stored?.salt || '0'.repeat(32), derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return !!stored && equalSecret(derived.toString('hex'), stored.hash);
}
export function validateIDToken(token, jwks, { issuer, clientId, nonce, now = Date.now() / 1000 }) {
    if (typeof token !== 'string' || token.length > 32000) throw failure(401, 'Invalid identity token');
    const parts = token.split('.'); if (parts.length !== 3) throw failure(401, 'Invalid identity token');
    let head, claims; try { head = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw failure(401, 'Invalid identity token'); }
    if (!['RS256', 'PS256', 'ES256'].includes(head.alg) || head.crit || head.jku || head.x5u) throw failure(401, 'Unsupported identity signature');
    const keys = (jwks.keys || []).filter(k => (!head.kid || k.kid === head.kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === head.alg) && (head.alg === 'ES256' ? k.kty === 'EC' && k.crv === 'P-256' : k.kty === 'RSA'));
    if (keys.length !== 1) throw failure(401, 'Identity signing key is not available');
    const key = createPublicKey({ key: keys[0], format: 'jwk' });
    if (head.alg !== 'ES256' && key.asymmetricKeyDetails?.modulusLength < 2048) throw failure(401, 'Identity key is too small');
    const options = head.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : head.alg === 'PS256' ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : key;
    if (!verifySignature('sha256', Buffer.from(parts[0] + '.' + parts[1]), options, Buffer.from(parts[2], 'base64url'))) throw failure(401, 'Invalid identity signature');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audiences.includes(clientId) || (audiences.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) throw failure(401, 'Identity issuer or audience mismatch');
    if (!Number.isFinite(claims.exp) || claims.exp < now - 30 || !Number.isFinite(claims.iat) || claims.iat > now + 30 || claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30)) throw failure(401, 'Identity token is expired or not yet valid');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || !equalSecret(claims.nonce, nonce)) throw failure(401, 'Identity subject or nonce mismatch');
    return claims;
}
export class IdentityService {
    constructor(store, options = {}) {
        this.store = store; this.options = options;
        this.registration = options.allowRegistration ?? process.env.ALLOW_REGISTRATION !== 'false';
        this.publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || '';
        if (this.publicOrigin) { const u = new URL(this.publicOrigin); if (u.origin !== this.publicOrigin.replace(/\/$/, '') || u.username || u.password || u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) throw Error('PUBLIC_ORIGIN must be an HTTPS origin (HTTP is permitted only on loopback)'); }
        this.oidc = options.oidc || (process.env.OIDC_ISSUER ? { issuer: process.env.OIDC_ISSUER, allowPrivate: process.env.OIDC_ALLOW_PRIVATE === 'true', clientId: process.env.OIDC_CLIENT_ID, clientSecret: process.env.OIDC_CLIENT_SECRET, authMethod: process.env.OIDC_AUTH_METHOD || 'client_secret_post', scopes: process.env.OIDC_SCOPES || 'openid profile email', domains: (process.env.OIDC_EMAIL_DOMAINS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean) } : null);
        this.scimToken = options.scimToken || process.env.SCIM_TOKEN; this.scimSpace = options.scimSpace || process.env.SCIM_WORKSPACE_ID;
    }
    async limit(key, max = 10, period = 60000) {
        const now = Date.now();
        const result = await this.store.transaction('rate:' + sha(key), current => { const r = current && now - current.at < period ? current : { at: now, count: 0 }; r.count++; return { value: r, result: r.count <= max }; });
        if (!result.result) throw failure(429, 'Too many attempts; try again later');
    }
    origin(req) {
        if (this.publicOrigin) return this.publicOrigin.replace(/\/$/, '');
        const host = req.headers.host || ''; if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw failure(503, 'Set PUBLIC_ORIGIN to the deployment HTTPS origin');
        return `${req.socket.encrypted ? 'https' : 'http'}://${host}`;
    }
    setCookie(res, name, value, seconds = 43200) { const secure = this.publicOrigin.startsWith('https:'); res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`); }
    async context(req) {
        const token = cookieValue(req, 'orivane_session'); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { user: null, session: null };
        const key = 'session:' + sha(token), session = await this.store.get(key);
        if (!session || session.expires < Date.now()) return { user: null, session: null };
        const identity = state(await this.store.get('identity')), user = identity.users[session.userId];
        if (!user || !user.active || (user.sessionVersion || 0) !== session.version) return { user: null, session: null };
        return { user, session, sessionKey: key, identity };
    }
    csrf(req, context) {
        if (context.user && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !equalSecret(req.headers['x-csrf-token'], context.session.csrf)) throw failure(403, 'CSRF token is required');
    }
    requireUser(context) { if (!context.user) throw failure(401, 'Sign in to use this feature'); return context.user; }
    async session(user, res) {
        const token = randomToken(), csrf = randomToken(), now = Date.now();
        await this.store.put('session:' + sha(token), { userId: user.id, csrf, created: now, expires: now + 12 * 3600000, version: user.sessionVersion || 0 });
        this.setCookie(res, 'orivane_session', token);
        return { user: publicUser(user), csrf };
    }
    async workspace(id, context, admin = false) {
        this.requireUser(context); const identity = state(await this.store.get('identity')), workspace = identity.spaces[id], role = workspace?.members[context.user.id];
        if (!workspace || !role) throw failure(403, 'Workspace access denied');
        if (workspace.requireSSO && context.user.provider !== 'oidc') throw failure(403, 'This workspace requires SSO');
        if (admin && !['owner', 'admin'].includes(role)) throw failure(403, 'Workspace administrator permission required');
        return { workspace, role, identity };
    }
    async role(room, context, bearer) {
        if (room.deleted) return null;
        if (room.workspaceId) {
            const identity = state(await this.store.get('identity')), ws = identity.spaces[room.workspaceId]; if (!ws) return null;
            const member = context.user && ws.members[context.user.id];
            if (member && (!ws.requireSSO || context.user.provider === 'oidc')) {
                if (room.acl?.[context.user.id] === 'none') return null;
                return room.ownerId === context.user.id || ['owner', 'admin'].includes(member) ? 'owner' : room.acl?.[context.user.id] || (member === 'viewer' ? 'viewer' : 'editor');
            }
            if (!ws.guestLinks || ws.requireSSO) return null;
        }
        if (typeof bearer !== 'string' || bearer.length !== 43) return null;
        const hash = sha(bearer); return Object.keys(room.hashes || {}).find(role => equalSecret(room.hashes[role], hash)) || null;
    }
    async handle(req, res, url, ctx, { body, send }) {
        const p = url.pathname, method = req.method;
        if (p.startsWith('/scim/v2/')) return this.scim(req, res, url, { body, send });
        if (p === '/api/auth/me' && method === 'GET') { send(res, 200, { user: publicUser(ctx.user), csrf: ctx.session?.csrf || null, registration: this.registration, sso: !!this.oidc }); return true; }
        if (p === '/api/auth/register' && method === 'POST') {
            if (!this.registration) throw failure(403, 'Registration is disabled');
            await this.limit(req.socket.remoteAddress + ':register', 10, 3600000);
            const input = await body(req, 6000), email = cleanEmail(input.email), password = await passwordHash(input.password), name = cleanName(input.name) || email.split('@')[0];
            const result = await this.store.transaction('identity', current => { const data = state(current); if (Object.values(data.users).some(u => u.email === email && u.provider === 'password')) throw failure(409, 'An account with that email already exists'); const user = { id: uid('user'), email, name, password, provider: 'password', active: true, created: Date.now(), sessionVersion: 0 }; data.users[user.id] = user; appendAudit(data, user.id, 'account.register'); return { value: data, result: user }; });
            send(res, 201, await this.session(result.result, res)); return true;
        }
        if (p === '/api/auth/login' && method === 'POST') {
            await this.limit(req.socket.remoteAddress + ':login'); const input = await body(req, 6000), email = cleanEmail(input.email), data = state(await this.store.get('identity'));
            const user = Object.values(data.users).find(u => u.email === email && u.provider === 'password');
            if (!await checkPassword(input.password, user?.password) || !user?.active) throw failure(401, 'Invalid email or password');
            send(res, 200, await this.session(user, res)); return true;
        }
        if (p === '/api/auth/logout' && method === 'POST') { this.csrf(req, ctx); if (ctx.sessionKey) await this.store.put(ctx.sessionKey, null); this.setCookie(res, 'orivane_session', '', 0); send(res, 200, { ok: true }); return true; }
        if (['/api/auth/password', '/api/auth/revoke-sessions'].includes(p) && method === 'POST') {
            this.requireUser(ctx); this.csrf(req, ctx); const input = await body(req, 6000); let password;
            if (p.endsWith('/password')) { if (!await checkPassword(input.currentPassword, ctx.user.password)) throw failure(401, 'Current password is incorrect'); password = await passwordHash(input.newPassword); }
            await this.store.transaction('identity', current => { const data = state(current), u = data.users[ctx.user.id]; if (password) u.password = password; u.sessionVersion = (u.sessionVersion || 0) + 1; appendAudit(data, u.id, 'account.revoke-sessions'); return { value: data }; });
            this.setCookie(res, 'orivane_session', '', 0); send(res, 200, { ok: true }); return true;
        }
        if (p === '/api/auth/oidc/start' && method === 'GET') { await this.startOIDC(req, res); return true; }
        if (p === '/api/auth/oidc/callback' && method === 'GET') { await this.finishOIDC(req, res, url); return true; }
        if (p === '/api/workspaces') {
            this.requireUser(ctx);
            if (method === 'GET') { const data = state(await this.store.get('identity')); send(res, 200, { workspaces: Object.values(data.spaces).filter(w => w.members[ctx.user.id]).map(w => ({ id: w.id, name: w.name, role: w.members[ctx.user.id], guestLinks: w.guestLinks, requireSSO: !!w.requireSSO })) }); return true; }
            if (method === 'POST') {
                this.csrf(req, ctx); const input = await body(req, 5000); if (!cleanName(input.name)) throw failure(400, 'Workspace name required');
                const result = await this.store.transaction('identity', current => { const data = state(current); if (Object.values(data.spaces).filter(w => w.members[ctx.user.id] === 'owner').length >= 50) throw failure(413, 'Workspace limit reached'); const workspace = { id: uid('space'), name: cleanName(input.name), created: Date.now(), members: { [ctx.user.id]: 'owner' }, guestLinks: false, requireSSO: false, retentionDays: 365, audit: [] }; data.spaces[workspace.id] = workspace; appendAudit(workspace, ctx.user.id, 'workspace.create'); return { value: data, result: workspace }; });
                send(res, 201, result.result); return true;
            }
        }
        if (p === '/api/workspace-invites/accept' && method === 'POST') {
            this.requireUser(ctx); this.csrf(req, ctx); const input = await body(req, 5000), hash = sha(String(input.token || ''));
            const result = await this.store.transaction('identity', current => { const data = state(current), invitation = data.invites[hash]; if (!invitation || invitation.expires < Date.now() || invitation.used || invitation.email && invitation.email !== ctx.user.email) throw failure(403, 'Invalid or expired workspace invitation'); const ws = data.spaces[invitation.workspaceId]; if (!ws) throw failure(404, 'Workspace not found'); const ranks = { viewer: 0, member: 1, admin: 2, owner: 3 }; if (!ws.members[ctx.user.id] || ranks[invitation.role] > ranks[ws.members[ctx.user.id]]) ws.members[ctx.user.id] = invitation.role; invitation.used = true; appendAudit(ws, ctx.user.id, 'workspace.invitation-accepted'); return { value: data, result: { workspaceId: ws.id } }; }); send(res, 200, result.result); return true;
        }
        const match = p.match(/^\/api\/workspaces\/(space_[\w-]+)(?:\/(members|invites|audit))?$/);
        if (match) {
            const [, id, action] = match, access = await this.workspace(id, ctx, method !== 'GET' || action === 'audit');
            if (method === 'GET') {
                if (action === 'audit') send(res, 200, { anchor: access.workspace.auditAnchor || '0'.repeat(64), events: access.workspace.audit || [] });
                else send(res, 200, { id, name: access.workspace.name, role: access.role, guestLinks: access.workspace.guestLinks, requireSSO: !!access.workspace.requireSSO, retentionDays: access.workspace.retentionDays, members: Object.entries(access.workspace.members).map(([id, role]) => ({ ...publicUser(access.identity.users[id]), role })) });
                return true;
            }
            this.csrf(req, ctx); const input = await body(req, 15000);
            if (action === 'invites' && method === 'POST') {
                if (!['member', 'viewer'].includes(input.role)) throw failure(400, 'Invalid invitation role');
                const token = randomToken(), email = input.email ? cleanEmail(input.email) : null;
                await this.store.transaction('identity', current => { const data = state(current), ws = data.spaces[id]; if (!['owner', 'admin'].includes(ws.members[ctx.user.id])) throw failure(403, 'Workspace permission changed'); data.invites[sha(token)] = { workspaceId: id, role: input.role, email, expires: Date.now() + 7 * 86400000, used: false }; appendAudit(ws, ctx.user.id, 'workspace.invite', { role: input.role }); return { value: data }; });
                send(res, 201, { token, workspaceId: id, expiresIn: 604800 }); return true;
            }
            if (action === 'members' && ['POST', 'PATCH', 'DELETE'].includes(method)) {
                if (!validId(input.userId) || !['member', 'viewer', 'admin', 'owner', 'remove'].includes(input.role)) throw failure(400, 'Invalid member or role');
                await this.store.transaction('identity', current => { const data = state(current), ws = data.spaces[id], actorRole = ws.members[ctx.user.id]; if (!['admin','owner'].includes(actorRole)) throw failure(403, 'Workspace permission changed'); if (!data.users[input.userId]) throw failure(404, 'Account not found'); if (actorRole !== 'owner' && (['owner','admin'].includes(input.role) || ['owner','admin'].includes(ws.members[input.userId]))) throw failure(403, 'Only owners manage administrators'); if (ws.members[input.userId] === 'owner' && input.role !== 'owner' && Object.values(ws.members).filter(r => r === 'owner').length < 2) throw failure(409, 'A workspace must retain an owner'); if (input.role === 'remove') delete ws.members[input.userId]; else ws.members[input.userId] = input.role; appendAudit(ws, ctx.user.id, 'workspace.member-changed', { userId: input.userId, role: input.role }); return { value: data }; });
                send(res, 200, { ok: true }); return true;
            }
            if (!action && method === 'PATCH') {
                await this.store.transaction('identity', current => { const data = state(current), ws = data.spaces[id]; if (!['owner','admin'].includes(ws.members[ctx.user.id])) throw failure(403, 'Workspace permission changed'); if (input.name !== undefined) ws.name = cleanName(input.name) || ws.name; if (input.guestLinks !== undefined) ws.guestLinks = !!input.guestLinks; if (input.requireSSO !== undefined) { if (input.requireSSO && (ctx.user.provider !== 'oidc' || !this.oidc)) throw failure(409, 'Sign in with configured SSO before requiring it'); ws.requireSSO = !!input.requireSSO; } if (input.retentionDays !== undefined) ws.retentionDays = Math.max(7, Math.min(3650, Math.round(+input.retentionDays || 365))); appendAudit(ws, ctx.user.id, 'workspace.policy-changed'); return { value: data }; }); send(res, 200, { ok: true }); return true;
            }
        }
        return false;
    }
    async discovery(force = false) {
        if (!this.oidc?.clientId) throw failure(503, 'SSO is not configured');
        if (!force && this.cachedDiscovery?.expires > Date.now()) return this.cachedDiscovery;
        const issuer = this.oidc.issuer.replace(/\/$/, ''), allowPrivate = !!this.oidc.allowPrivate;
        const response = await requestExternal(issuer + '/.well-known/openid-configuration', { allowPrivate });
        if (response.status !== 200) throw failure(502, 'Identity discovery failed'); const metadata = response.json();
        if (metadata.issuer !== issuer) throw failure(502, 'Identity discovery issuer mismatch');
        for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) { const u = new URL(metadata[key]); if (u.protocol !== 'https:' && !allowPrivate) throw failure(502, 'Identity endpoints require HTTPS'); }
        const jwkResponse = await requestExternal(metadata.jwks_uri, { allowPrivate }); if (jwkResponse.status !== 200) throw failure(502, 'Identity keys unavailable');
        this.cachedDiscovery = { metadata, keys: jwkResponse.json(), expires: Date.now() + 300000 }; return this.cachedDiscovery;
    }
    async startOIDC(req, res) {
        await this.limit(req.socket.remoteAddress + ':oidc', 30); const { metadata } = await this.discovery();
        const stateToken = randomToken(), verifier = randomToken(), nonce = randomToken(), browser = randomToken(), redirect = this.origin(req) + '/api/auth/oidc/callback';
        await this.store.put('oidc:' + sha(stateToken), { verifier, nonce, browser: sha(browser), redirect, expires: Date.now() + 600000 });
        this.setCookie(res, 'orivane_oidc', browser, 600);
        const target = new URL(metadata.authorization_endpoint); for (const [k, v] of Object.entries({ client_id: this.oidc.clientId, response_type: 'code', redirect_uri: redirect, scope: this.oidc.scopes || 'openid profile email', state: stateToken, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') })) target.searchParams.set(k, v);
        res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store' }); res.end();
    }
    async finishOIDC(req, res, url) {
        const stateToken = url.searchParams.get('state'), code = url.searchParams.get('code'); if (!stateToken || !code || code.length > 5000) throw failure(401, 'Identity callback is incomplete');
        const taken = await this.store.transaction('oidc:' + sha(stateToken), current => { if (!current || current.expires < Date.now() || !equalSecret(current.browser, sha(cookieValue(req, 'orivane_oidc')))) throw failure(401, 'Invalid or expired sign-in state'); return { value: null, result: current }; }), flow = taken.result;
        const { metadata, keys } = await this.discovery(); const values = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: flow.redirect, client_id: this.oidc.clientId, code_verifier: flow.verifier });
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (this.oidc.clientSecret) {
            if (this.oidc.authMethod === 'client_secret_post') values.set('client_secret', this.oidc.clientSecret);
            else headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(this.oidc.clientId) + ':' + encodeURIComponent(this.oidc.clientSecret)).toString('base64');
        }
        const response = await requestExternal(metadata.token_endpoint, { method: 'POST', headers, body: values.toString(), allowPrivate: !!this.oidc.allowPrivate });
        if (response.status !== 200) throw failure(401, 'Identity code exchange failed'); const tokens = response.json(); let claims;
        try { claims = validateIDToken(tokens.id_token, keys, { issuer: metadata.issuer, clientId: this.oidc.clientId, nonce: flow.nonce }); }
        catch (e) { if (!e.message.includes('signing key')) throw e; const renewed = await this.discovery(true); claims = validateIDToken(tokens.id_token, renewed.keys, { issuer: metadata.issuer, clientId: this.oidc.clientId, nonce: flow.nonce }); }
        const email = cleanEmail(claims.email); if (claims.email_verified !== true) throw failure(403, 'SSO must supply a verified email address');
        if (this.oidc.domains?.length && !this.oidc.domains.includes(email.split('@')[1])) throw failure(403, 'This identity domain is not allowed');
        const subject = sha(metadata.issuer + '\0' + claims.sub);
        const result = await this.store.transaction('identity', current => { const data = state(current); let user = Object.values(data.users).find(u => u.subject === subject); if (!user) { user = { id: uid('user'), subject, provider: 'oidc', active: true, created: Date.now(), sessionVersion: 0 }; data.users[user.id] = user; } if (!user.active) throw failure(403, 'Account has been deactivated'); user.email = email; user.emailVerified = true; user.name = cleanName(claims.name) || email; appendAudit(data, user.id, 'account.sso-login'); return { value: data, result: user }; });
        await this.session(result.result, res); res.writeHead(303, { Location: this.origin(req) + '/', 'Cache-Control': 'no-store' }); res.end();
    }
    async scim(req, res, url, { body, send }) {
        if (!this.scimToken || !this.scimSpace || !equalSecret((req.headers.authorization || '').replace(/^Bearer /, ''), this.scimToken)) throw failure(403, 'SCIM provisioning is not authorized');
        const parts = url.pathname.slice('/scim/v2/'.length).split('/'), type = parts[0], id = parts[1];
        const schema = resource => `urn:ietf:params:scim:schemas:core:2.0:${resource}`;
        if (type === 'ServiceProviderConfig') { send(res, 200, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 100 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: true }, authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Provisioning bearer', description: 'Administrator-configured workspace-scoped token' }] }); return true; }
        if (type === 'ResourceTypes') { send(res, 200, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 2, Resources: ['User', 'Group'].map(n => ({ id: n, name: n, endpoint: '/' + n + 's', schema: schema(n) })) }); return true; }
        if (type === 'Schemas') { send(res, 200, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 2, Resources: ['User', 'Group'].map(n => ({ id: schema(n), name: n, attributes: (n === 'User' ? ['userName', 'displayName', 'active', 'externalId'] : ['displayName', 'members']).map(name => ({ name, type: name === 'active' ? 'boolean' : name === 'members' ? 'complex' : 'string', multiValued: name === 'members', required: name === 'userName', mutability: 'readWrite', returned: 'default' })) })) }); return true; }
        if (!['Users', 'Groups'].includes(type)) throw failure(404, 'Unknown SCIM resource');
        const resource = (data, item) => type === 'Users' ? { schemas: [schema('User')], id: item.id, userName: item.email, displayName: item.name, active: item.active, externalId: item.externalId, emails: [{ value: item.email, primary: true }], meta: { resourceType: 'User', version: `W/"${item.scimVersion || 1}"` } } : { schemas: [schema('Group')], id: item.id, displayName: item.name, members: (item.members || []).map(value => ({ value })), meta: { resourceType: 'Group', version: `W/"${item.scimVersion || 1}"` } };
        if (req.method === 'GET') {
            const data = state(await this.store.get('identity')); if (!data.spaces[this.scimSpace]) throw failure(404, 'Provisioning workspace not found');
            let list = Object.values(type === 'Users' ? data.users : data.groups).filter(o => o.provisionedSpace === this.scimSpace);
            if (id) { const item = list.find(o => o.id === id); if (!item) throw failure(404, 'Resource not found'); res.setHeader('ETag', `W/"${item.scimVersion || 1}"`); send(res, 200, resource(data, item)); return true; }
            const filter = url.searchParams.get('filter'); if (filter) { const m = filter.match(/^(userName|displayName|externalId) eq "([^"\\]*)"$/); if (!m) throw failure(400, 'Unsupported SCIM filter'); list = list.filter(o => ({ userName: o.email, displayName: o.name, externalId: o.externalId })[m[1]] === m[2]); }
            const start = Math.max(1, +(url.searchParams.get('startIndex') || 1)), count = Math.max(0, Math.min(100, +(url.searchParams.get('count') || 100)));
            send(res, 200, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: list.length, startIndex: start, itemsPerPage: Math.min(count, Math.max(0, list.length - start + 1)), Resources: list.slice(start - 1, start - 1 + count).map(o => resource(data, o)) }); return true;
        }
        const input = req.method === 'DELETE' ? {} : await body(req, 100000);
        const result = await this.store.transaction('identity', current => {
            const data = state(current), ws = data.spaces[this.scimSpace]; if (!ws) throw failure(404, 'Provisioning workspace not found');
            const collection = type === 'Users' ? data.users : data.groups;
            let item = id && collection[id]; if (id && (!item || item.provisionedSpace !== this.scimSpace)) throw failure(404, 'Resource not found');
            if (req.headers['if-match'] && req.headers['if-match'] !== `W/"${item?.scimVersion || 1}"`) throw failure(412, 'Provisioning version changed');
            const protectLastOwner = userId => {
                for (const space of Object.values(data.spaces)) {
                    if (space.members?.[userId] === 'owner' && !Object.entries(space.members).some(([other, role]) => other !== userId && role === 'owner' && data.users[other]?.active !== false))
                        throw failure(409, 'Transfer workspace ownership before deactivating the last owner');
                }
            };
            if (req.method === 'DELETE') {
                if (type === 'Users') { protectLastOwner(id); item.active = false; item.sessionVersion = (item.sessionVersion || 0) + 1; delete ws.members[id]; }
                else delete collection[id];
                appendAudit(ws, 'scim', 'scim.delete', { id }); return { value: data, result: null };
            }
            if (req.method === 'POST') { if (id) throw failure(400, 'POST requires collection endpoint'); item = { id: uid(type === 'Users' ? 'user' : 'group'), provisionedSpace: this.scimSpace, active: true, provider: 'oidc', scimVersion: 0, members: [] }; collection[item.id] = item; }
            if (!item || !['POST', 'PUT', 'PATCH'].includes(req.method)) throw failure(405, 'Method not allowed');
            const assign = (key, value, op = 'replace') => {
                if (key === 'userName' && type === 'Users') item.email = cleanEmail(value);
                else if (key === 'displayName') item.name = cleanName(value);
                else if (key === 'active' && type === 'Users') { if (typeof value !== 'boolean') throw failure(400, 'active must be boolean'); if (item.active !== value) item.sessionVersion = (item.sessionVersion || 0) + 1; item.active = value; }
                else if (key === 'externalId' && type === 'Users') { item.externalId = String(value).slice(0, 255); if (this.oidc?.issuer) item.subject = sha(this.oidc.issuer.replace(/\/$/, '') + '\0' + item.externalId); }
                else if (key === 'members' && type === 'Groups') { if (op === 'remove' && !value) item.members = []; else { if (!Array.isArray(value) || value.length > 5000 || value.some(m => !data.users[m.value] || data.users[m.value].provisionedSpace !== this.scimSpace)) throw failure(400, 'Invalid group membership'); const ids = value.map(m => m.value); item.members = op === 'add' ? [...new Set([...item.members, ...ids])] : op === 'remove' ? item.members.filter(id => !ids.includes(id)) : [...new Set(ids)]; } }
                else if (!['schemas','id','meta','emails','name'].includes(key)) throw failure(400, 'Unsupported provisioning attribute: ' + key);
            };
            if (req.method === 'PATCH') {
                if (!Array.isArray(input.Operations) || input.Operations.length > 100) throw failure(400, 'Invalid provisioning operations');
                for (const operation of input.Operations) {
                    const op = String(operation.op).toLowerCase(); if (!['add','replace','remove'].includes(op)) throw failure(400, 'Unsupported provisioning operation');
                    if (!operation.path) { if (op === 'remove' || !operation.value || typeof operation.value !== 'object') throw failure(400, 'Attribute values required'); for (const [k, v] of Object.entries(operation.value)) assign(k, v, op); }
                    else { const member = operation.path.match(/^members\[value eq "([\w-]+)"\]$/); if (member && op === 'remove') assign('members', [{ value: member[1] }], 'remove'); else assign(operation.path, operation.value, op); }
                }
            } else for (const [key, value] of Object.entries(input)) assign(key, value);
            if (type === 'Users') { if (!item.email) throw failure(400, 'userName is required'); if (Object.values(data.users).some(u => u.id !== item.id && (u.email === item.email && u.provisionedSpace === this.scimSpace || item.subject && u.subject === item.subject))) throw failure(409, 'User already exists'); if (item.active) ws.members[item.id] ||= 'member'; else { protectLastOwner(item.id); delete ws.members[item.id]; } }
            item.scimVersion = (item.scimVersion || 0) + 1; appendAudit(ws, 'scim', 'scim.upsert', { id: item.id, type });
            return { value: data, result: resource(data, item) };
        });
        if (result.result === null) { res.writeHead(204); res.end(); }
        else { res.setHeader('ETag', result.result.meta.version); send(res, req.method === 'POST' ? 201 : 200, result.result); }
        return true;
    }
}
