import { describe, it, expect } from 'vitest';
import { MemoryRelayStore } from './store.js';

const msg = { id: 'a'.repeat(32), ts: 100, pubkey: 'b'.repeat(64), name: 'alice', text: 'original', sig: 'c'.repeat(128) };

describe('MemoryRelayStore matches SQLite invariants', () => {
  it('duplicate insert does not duplicate backlog or overwrite content', async () => {
    const store = new MemoryRelayStore();
    await store.insertMessage(msg);
    await store.insertMessage({ ...msg, text: 'replacement' });
    expect(await store.getBacklog(50)).toHaveLength(1);
    expect((await store.getMessageById(msg.id))?.text).toBe('original');
  });
  it('prune cleans reports along with the message', async () => {
    const store = new MemoryRelayStore();
    await store.insertMessage(msg);
    await store.addReport(msg.id, 'reporter');
    await store.pruneOlderThan(101);
    expect(await store.getMessageById(msg.id)).toBeNull();
    expect(await store.countReporters(msg.id)).toBe(0);
  });
  it('empty address is never banned and replacement ban removes the old hash', async () => {
    const store = new MemoryRelayStore();
    await store.addBan(msg.pubkey, '');
    expect(await store.isBannedIp('')).toBe(false);
    await store.addBan(msg.pubkey, 'old');
    await store.addBan(msg.pubkey, 'new');
    expect(await store.isBannedIp('old')).toBe(false);
    expect(await store.isBannedIp('new')).toBe(true);
  });
  it('upsert keeps the original first-seen timestamp', async () => {
    const store = new MemoryRelayStore();
    await store.upsertKeyRecord({ pubkey: msg.pubkey, name: 'alice', firstSeenAt: 1, nameChangedAt: 0 });
    await store.upsertKeyRecord({ pubkey: msg.pubkey, name: 'alicia', firstSeenAt: 2, nameChangedAt: 3 });
    expect((await store.getKeyRecord(msg.pubkey))?.firstSeenAt).toBe(1);
  });
});
