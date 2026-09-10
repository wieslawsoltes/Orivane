import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { BoardDocument } from '../../public/core/model.js';
export async function fixture(options = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'orivane-enterprise-')), app = await createApp({ dataDir: directory, ...options });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (route, data, auth = {}, method = data === undefined ? 'GET' : 'POST', extra = {}) => fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth.cookie ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data), redirect: 'manual' });
    const register = async (email = 'owner@example.test', name = 'Test Owner') => { const response = await request('/api/auth/register', { email, name, password: 'A-strong-password-123!' }); if (response.status !== 201) throw Error(await response.text()); return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] }; };
    const doc = new BoardDocument('seed'); doc.transact([{ id: 'note', props: { type: 'sticky', x: 0, y: 0, w: 160, h: 160, text: 'Hello world', fill: '#fff0a6' } }, { id: 'board_meta', props: { type: 'meta', title: 'Enterprise test' } }]);
    const room = async (auth = {}, workspaceId = null) => { const response = await request('/api/rooms', { snapshot: doc.snapshot(), workspaceId }, auth); if (response.status !== 201) throw Error(await response.text()); return response.json(); };
    const headers = (room, actor = 'tester', role = 'owner', secret = 'testclient___________________') => ({ 'X-Orivane-Actor': actor, 'X-Orivane-Client': secret, Authorization: 'Bearer ' + (room[role + 'Token'] || '') });
    return { app, base, directory, request, register, room, doc, headers, async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
export async function wait(fn, message = 'condition', timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); } throw Error('Timed out: ' + message); }
