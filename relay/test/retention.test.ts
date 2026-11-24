import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { generateKeyPair, importPrivateKey, sign } from '../../src/global-chat/crypto.js';
import { canonicalHello, canonicalPost } from '../../src/global-chat/protocol.js';

// A source transform confined to this local bundle, NOT an env/config production override.
const bundle = await build({ entryPoints: ['test/retention-worker.ts'], bundle: true, write: false,
  format: 'esm', platform: 'browser', plugins: [{ name: 'test-short-retention', setup(builder) {
    builder.onLoad({ filter: /global-chat\/protocol\.ts$/ }, async ({ path }) => ({
      contents: (await readFile(path, 'utf8')).replace('7 * 24 * 60 * 60 * 1000', '1000'), loader: 'ts',
    }));
  } }] });

await test('real alarm physically deletes expired posts with no reconnect or traffic', async () => {
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: '2025-07-18', durableObjects: { ROOM: { className: 'RetentionTestRoom', useSQLite: true } },
    bindings: { IP_SALT: 'local-test-salt-more-than-sixteen', ADMIN_PUBKEYS: '' } });
  let socket: WebSocket | undefined;
  try {
    const url = await mf.ready;
    socket = new WebSocket(url.href.replace('http:', 'ws:'));
    const frames: any[] = [];
    socket.addEventListener('message', event => frames.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve()); socket!.addEventListener('error', reject);
    });
    const kp = await generateKeyPair();
    const sk = await importPrivateKey(kp.privateKeyPkcs8);
    const hello = { ts: Date.now(), pubkey: kp.pubkey, name: 'alice' };
    socket.send(JSON.stringify({ t: 'hello', v: 1, ...hello, sig: await sign(canonicalHello(hello), sk) }));
    const wait = async (predicate: () => boolean) => {
      const end = Date.now() + 5000;
      while (!predicate() && Date.now() < end) await delay(10);
      assert(predicate(), 'expected frame before timeout');
    };
    await wait(() => frames.some(f => f.t === 'welcome'));
    const post = { id: 'a'.repeat(32), ts: Date.now(), name: 'alice', text: 'expires quietly' };
    socket.send(JSON.stringify({ t: 'post', id: post.id, ts: post.ts, text: post.text,
      sig: await sign(canonicalPost(post), sk) }));
    await wait(() => frames.some(f => f.t === 'ack'));
    await delay(1800);
    const rows = await (await mf.dispatchFetch('http://local/rows')).json() as any[];
    assert.equal(rows[0].n, 0, 'alarm physically removed SQLite row without hello');
  } finally { socket?.close(); await mf.dispose(); }
});
