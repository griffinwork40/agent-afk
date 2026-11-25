import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { setTimeout as delay } from 'node:timers/promises';

const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const script = bundle.outputFiles[0]!.text;
const options = { modules: true, script, compatibilityDate: '2025-07-18',
  durableObjects: { ROOM: { className: 'ChatRoom', useSQLite: true } } };

await test('Worker routes without instantiating a room for HTTP and refuses weak salt', async () => {
  const mf = new Miniflare({ ...options, bindings: { IP_SALT: '', ADMIN_PUBKEYS: '' } });
  try {
    assert.equal((await mf.dispatchFetch('http://local/')).status, 200);
    assert.equal((await mf.dispatchFetch('http://local/unknown')).status, 404);
    assert.equal((await mf.dispatchFetch('http://local/v1/room/global')).status, 426);
    const response = await mf.dispatchFetch('http://local/v1/room/global', { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /IP_SALT/);
  } finally { await mf.dispose(); }
});

await test('pending-socket cap and real persistent alarm release idle sockets', async () => {
  const mf = new Miniflare({ ...options, bindings: { IP_SALT: 'local-test-salt-more-than-sixteen', ADMIN_PUBKEYS: '' } });
  const sockets: any[] = [];
  try {
    const local = await mf.ready;
    const wsUrl = local.href.replace('http:', 'ws:') + 'v1/room/global';
    for (let i = 0; i < 5; i++) {
      const socket = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', reject);
      });
      sockets.push(socket);
    }
    assert.equal((await mf.dispatchFetch('http://local/v1/room/global', { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '127.0.0.1' } })).status, 429);
    const deadline = Date.now() + 15000;
    // Node's WebSocket enters CLOSING upon the peer's close frame; close event
    // waits for the other half of the transport to finish. Assert the frame was
    // received rather than imposing a TCP shutdown timing assumption.
    while (sockets.some(socket => socket.readyState === 1) && Date.now() < deadline) await delay(50);
    assert(sockets.every(socket => socket.readyState >= 2), 'all pending sockets received the alarm close frame');
    const admitted = await mf.dispatchFetch('http://local/v1/room/global', { headers: { Upgrade: 'websocket' } });
    assert.equal(admitted.status, 101); admitted.webSocket!.accept(); admitted.webSocket!.close();
  } finally {
    for (const socket of sockets) try { socket.close(); } catch { /* already closed */ }
    await mf.dispose();
  }
});
