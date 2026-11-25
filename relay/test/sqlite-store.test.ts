import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const bundle = await build({ entryPoints: ['test/store-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const script = bundle.outputFiles[0]!.text;
const key = 'a'.repeat(64);
const msg = (id: string, ts: number) => ({ id, ts, pubkey: key, name: 'alice', text: "O'Brien ?; DROP TABLE bans; --", sig: 'b'.repeat(128) });

await test('SqliteRelayStore: every method against real workerd SQLite', async t => {
  const persist = await mkdtemp(path.join(os.tmpdir(), 'afk-relay-sqlite-'));
  const options = { modules: true, script, compatibilityDate: '2025-07-18',
    durableObjects: { TEST: { className: 'StoreTestObject', useSQLite: true } }, durableObjectsPersist: persist };
  let mf = new Miniflare(options);
  async function call(method: string, ...args: unknown[]): Promise<any> {
    const response = await mf.dispatchFetch('http://local/', { method: 'POST', body: JSON.stringify({ method, args }) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as any).result;
  }
  try {
    await t.test('insert/id lookup/deleted filtering and bound hostile text', async () => {
      assert.equal(await call('getMessageById', 'absent'), null);
      await call('insertMessage', msg('one', 100));
      await call('insertMessage', msg('two', 200));
      await call('insertMessage', { ...msg('two', 200), text: 'duplicate must not replace' });
      assert.equal((await call('getMessageById', 'two')).text, msg('two', 200).text);
      assert.deepEqual((await call('getBacklog', 50)).map((m: any) => m.id), ['one', 'two']);
      await call('markDeleted', 'one');
      assert.equal((await call('getMessageById', 'one')).deleted, true);
      assert.deepEqual((await call('getBacklog', 50)).map((m: any) => m.id), ['two']);
      assert.equal(await call('countPostsByKeySince', key, 0), 1);
      assert.equal(await call('countPostsByKeySince', key, 201), 0);
    });
    await t.test('key and address bans, shared hash, key-only unban', async () => {
      await call('addBan', key, 'hash'); await call('addBan', 'other', 'hash');
      assert.equal(await call('isBannedKey', key), true); assert.equal(await call('isBannedIp', 'hash'), true);
      await call('removeBan', key); assert.equal(await call('isBannedKey', key), false);
      assert.equal(await call('isBannedIp', 'hash'), true); await call('removeBan', 'other');
      assert.equal(await call('isBannedIp', 'hash'), false);
      await call('addBan', key, ''); assert.equal(await call('isBannedIp', ''), false);
      await call('removeBan', key); assert.equal(await call('isBannedKey', key), false);
      await call('addBan', "'; DELETE FROM bans; --", 'hash-injection');
      assert.equal(await call('isBannedKey', "'; DELETE FROM bans; --"), true);
    });
    await t.test('registry preserves first seen while updating name and timestamp', async () => {
      assert.equal(await call('getKeyRecord', key), null);
      await call('upsertKeyRecord', { pubkey: key, name: 'alice', firstSeenAt: 100, lastSeenAt: 100, nameChangedAt: 0 });
      await call('upsertKeyRecord', { pubkey: key, name: 'alicia', firstSeenAt: 999, lastSeenAt: 999, nameChangedAt: 86400100 });
      assert.deepEqual(await call('getKeyRecord', key), { pubkey: key, name: 'alicia', firstSeenAt: 100, lastSeenAt: 999, nameChangedAt: 86400100 });
    });
    await t.test('registry prune preserves banned, recent and retained authors and bounds deletion batches', async () => {
      for (let i = 0; i < 105; i++) await call('upsertKeyRecord', { pubkey: 'idle-' + i,
        name: 'alice', firstSeenAt: 1, lastSeenAt: 1, nameChangedAt: 0 });
      await call('addBan', 'idle-0', '');
      await call('upsertKeyRecord', { pubkey: 'recent', name: 'alice', firstSeenAt: 1, lastSeenAt: 999, nameChangedAt: 0 });
      await call('pruneKeyRecords', 500);
      assert.notEqual(await call('getKeyRecord', key), null, 'retained author survives');
      assert.notEqual(await call('getKeyRecord', 'idle-0'), null, 'ban survives');
      assert.equal(await call('getKeyRecord', 'idle-1'), null);
      assert.notEqual(await call('getKeyRecord', 'idle-104'), null, 'only 100 deleted');
      await call('pruneKeyRecords', 500);
      assert.equal(await call('getKeyRecord', 'idle-104'), null);
      assert.notEqual(await call('getKeyRecord', 'recent'), null);
      assert.equal(await call('getOldestKeyTimestamp'), 999);
    });
    await t.test('reports count distinct keys and deletion is idempotent', async () => {
      await call('addReport', 'two', 'r1'); await call('addReport', 'two', 'r1');
      assert.equal(await call('countReporters', 'two'), 1);
      await call('addReport', 'two', 'r2'); await call('addReport', 'two', 'r3');
      assert.equal(await call('countReporters', 'two'), 3);
      await call('markDeleted', 'two'); await call('markDeleted', 'two');
      assert.deepEqual(await call('getBacklog', 50), []);
    });
    await t.test('bounded prune removes associated reports; backlog never leaks expired rows', async () => {
      for (let i = 0; i < 105; i++) await call('insertMessage', msg('old-' + i, i));
      await call('addReport', 'old-0', 'reporter');
      await call('pruneOlderThan', 150);
      assert.equal(await call('countReporters', 'old-0'), 0);
      assert((await call('getBacklog', 50)).every((m: any) => m.ts >= 150));
      await call('pruneOlderThan', 150);
      assert.equal(await call('getMessageById', 'old-104'), null);
    });
    await t.test('action replay ids persist across restart and prune in bounded batches', async () => {
      assert.equal(await call('consumeActionId', 'admin:one', 500, 100), true);
      await mf.dispose(); mf = new Miniflare(options);
      assert.equal(await call('consumeActionId', 'admin:one', 500, 100), false);
      for (let i = 0; i < 105; i++) await call('consumeActionId', 'report:' + i, 200, 100);
      await call('pruneActionIds', 200);
      assert.equal(await call('getOldestActionExpiry'), 200, 'only 100 expired ids pruned');
      await call('pruneActionIds', 200);
      assert.equal(await call('getOldestActionExpiry'), 500);
      assert.equal(await call('consumeActionId', 'admin:one', 900, 500), true);
      await call('pruneActionIds', 900);
      assert.equal(await call('getOldestActionExpiry'), null);
    });
    await t.test('mode and all durable data persist across runtime restart', async () => {
      assert.equal(await call('getRoomMode'), 'open');
      await call('setRoomMode', 'readonly');
      await call('insertMessage', msg('persisted', 999));
      await call('addBan', 'persistent-ban', 'persistent-hash');
      await mf.dispose(); mf = new Miniflare(options);
      assert.equal(await call('getRoomMode'), 'readonly');
      assert.equal(await call('isBannedKey', 'persistent-ban'), true);
      assert.equal(await call('isBannedIp', 'persistent-hash'), true);
      assert.deepEqual((await call('getBacklog', 50)).map((m: any) => m.id), ['persisted']);
      assert.equal((await call('getKeyRecord', key)).name, 'alicia');
      assert.equal(await call('countReporters', 'two'), 3);
      await call('setRoomMode', 'closed'); assert.equal(await call('getRoomMode'), 'closed');
      await call('setRoomMode', 'open'); assert.equal(await call('getRoomMode'), 'open');
    });
  } finally { await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
});
