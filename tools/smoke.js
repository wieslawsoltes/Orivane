/** Explicitly creates and deletes an isolated test board on a disposable deployment.
 * Usage: BASE_URL=http://localhost:4173 node tools/smoke.js --allow-write */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { BoardDocument } from '../public/core/model.js';
if (!process.argv.includes('--allow-write')) throw Error('This smoke test creates a test board. Pass --allow-write only against a disposable deployment with guest rooms enabled.');
const base = process.env.BASE_URL || 'http://localhost:4173', actor = 'smoke_' + randomBytes(8).toString('hex');
let room, headers;
async function request(route, data, auth = {}) {
    const r = await fetch(new URL(route, base), { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw Error(`${route}: ${r.status} ${await r.text()}`);
    return r.json();
}
try {
    assert.equal((await request('/api/ready')).ready, true);
    assert.equal((await request('/api/health')).version, '0.2.0');
    const doc = new BoardDocument(actor); doc.transact([{id:'smoke_note', props:{type:'sticky',text:'Deployment check',x:0,y:0,w:200,h:200}}]);
    room = await request('/api/rooms', {snapshot:doc.snapshot()});
    headers = {Authorization:'Bearer '+room.ownerToken,'X-Orivane-Actor':actor,'X-Orivane-Client':randomBytes(24).toString('base64url')};
    const op = doc.transact([{id:'smoke_note',props:{text:'Deployment check: saved 🌿'}}]);
    assert.equal((await request(`/api/rooms/${room.id}/ops`,op,headers)).ack,op.id);
    for (let i=0;i<4;i++) { const read = new BoardDocument('read'); read.merge(await request(`/api/rooms/${room.id}/snapshot`,undefined,headers)); assert.equal(read.get('smoke_note').text,'Deployment check: saved 🌿'); }
    console.log('PASS readiness, version, room creation, character edit, repeated durable reads');
} finally {
    if (room) { await request(`/api/rooms/${room.id}/delete`,{confirm:true},headers); console.log('Test board deleted'); }
}
