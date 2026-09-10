import { createApp } from '../../server/index.js';
import { createStorageNode } from '../../server/storage-node.js';
const options = JSON.parse(process.env.ORIVANE_WORKER_OPTIONS || '{}');
const app = process.env.ORIVANE_WORKER_KIND === 'storage' ? await createStorageNode(options) : await createApp(options);
await new Promise(r => app.server.listen(options.port || 0, '127.0.0.1', r));
process.send({ port: app.server.address().port });
process.on('message', async message => { if (message === 'stop') { await app.close(); process.exit(0); } });
