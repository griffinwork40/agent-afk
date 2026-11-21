import { describe, it, expect, beforeEach } from 'vitest';
import { Room, countDistinctKeys, KEY_REGISTRATION_LIMIT, KEY_REGISTRATION_WINDOW_MS } from './room.js';
import { MemoryRelayStore } from './store.js';
import { generateKeyPair, importPrivateKey, sign, verifyMsg } from '../crypto.js';
import {
  canonicalHello, canonicalPost, canonicalReport, canonicalAdmin,
  REPORT_THRESHOLD, BACKLOG_SIZE,
} from '../protocol.js';
import type { ConnRecord, RelayConfig } from './room-types.js';
import type { Clock } from './limiter.js';
import type { StoredKeyPair } from '../crypto.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeClock(start = Date.now()): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function makeConfig(overrides?: Partial<RelayConfig>): RelayConfig {
  return {
    maintainerKeys: [],
    maxConnsPerIp: 5,
    ...overrides,
  };
}

async function buildHelloFrame(kp: StoredKeyPair, name: string, ts: number): Promise<string> {
  const sk = await importPrivateKey(kp.privateKeyPkcs8);
  const canonical = canonicalHello({ ts, pubkey: kp.pubkey, name });
  const sig = await sign(canonical, sk);
  return JSON.stringify({ t: 'hello', v: 1, pubkey: kp.pubkey, name, ts, sig });
}

async function buildPostFrame(kp: StoredKeyPair, id: string, ts: number, name: string, text: string): Promise<string> {
  const sk = await importPrivateKey(kp.privateKeyPkcs8);
  const canonical = canonicalPost({ id, ts, name, text });
  const sig = await sign(canonical, sk);
  return JSON.stringify({ t: 'post', id, ts, text, sig });
}

async function buildReportFrame(kp: StoredKeyPair, id: string, ts: number, target: string): Promise<string> {
  const sk = await importPrivateKey(kp.privateKeyPkcs8);
  const canonical = canonicalReport({ id, ts, target });
  const sig = await sign(canonical, sk);
  return JSON.stringify({ t: 'report', id, ts, target, sig });
}

async function buildAdminFrame(kp: StoredKeyPair, id: string, ts: number, op: string, arg: string): Promise<string> {
  const sk = await importPrivateKey(kp.privateKeyPkcs8);
  const canonical = canonicalAdmin({ id, ts, op: op as 'ban', arg });
  const sig = await sign(canonical, sk);
  return JSON.stringify({ t: 'admin', id, ts, op, arg, sig });
}

function randomId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// Do a full hello handshake; returns the updated conn record
async function doHello(
  room: Room,
  connId: string,
  kp: StoredKeyPair,
  name: string,
  _store: MemoryRelayStore,
  clock: Clock,
  allConns: Map<string, ConnRecord>,
  ipHash = 'ip1',
): Promise<ConnRecord> {
  const conn = allConns.get(connId) ?? room.onConnect(connId, ipHash);
  allConns.set(connId, conn);
  const frame = await buildHelloFrame(kp, name, clock.now());
  const effect = await room.onMessage(connId, frame, conn, allConns);
  expect(effect.toSender[0]?.t).toBe('welcome');
  allConns.set(connId, effect.conn);
  return effect.conn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Room hello', () => {
  let store: MemoryRelayStore;
  let clock: ReturnType<typeof makeClock>;
  let room: Room;
  let kp: StoredKeyPair;

  beforeEach(async () => {
    store = new MemoryRelayStore();
    clock = makeClock(1_700_000_000_000);
    room = new Room(store, makeConfig(), clock);
    kp = await generateKeyPair();
  });

  it('allows only one successful hello per connection, even with another key', async () => {
    const conns = new Map<string, ConnRecord>();
    const conn = await doHello(room, 'one', kp, 'alice', store, clock, conns);
    const other = await generateKeyPair();
    const result = await room.onMessage('one', await buildHelloFrame(other, 'bob', clock.now()), conn, conns);
    expect(result.toClose).toEqual(['one']);
    expect(result.toSender[0]).toMatchObject({ code: 'bad_frame', message: 'Hello already completed' });
    expect(await store.getKeyRecord(other.pubkey)).toBeNull();
  });

  it('limits new-key registrations by address but permits existing keys and window expiry', async () => {
    const conns = new Map<string, ConnRecord>();
    for (let i = 0; i < KEY_REGISTRATION_LIMIT; i++) {
      await doHello(room, 'one', i === 0 ? kp : await generateKeyPair(), 'alice', store, clock, conns);
      conns.clear();
    }
    const other = await generateKeyPair();
    const fresh = room.onConnect('one', 'ip1');
    const frame = await buildHelloFrame(other, 'alice', clock.now());
    const denied = await room.onMessage('one', frame, fresh, conns);
    expect(denied.toSender[0]).toMatchObject({ code: 'rate_limited', retryAfterMs: KEY_REGISTRATION_WINDOW_MS });
    expect(await store.getKeyRecord(other.pubkey)).toBeNull();
    await doHello(room, 'one', kp, 'alice', store, clock, conns);
    conns.clear();
    clock.advance(KEY_REGISTRATION_WINDOW_MS);
    await doHello(room, 'one', other, 'alice', store, clock, conns);
  });

  it('sends welcome on valid hello', async () => {
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const frame = await buildHelloFrame(kp, 'alice', clock.now());
    const effect = await room.onMessage('c1', frame, conn, allConns);
    expect(effect.toSender[0]?.t).toBe('welcome');
    const welcome = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'welcome' }>;
    expect(welcome.you.pubkey).toBe(kp.pubkey);
    expect(welcome.you.name).toBe('alice');
    expect(welcome.mode).toBe('open');
    expect(effect.conn.helloOk).toBe(true);
  });

  it('error not_hello for post before hello', async () => {
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const id = randomId();
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', 'hello world');
    const effect = await room.onMessage('c1', frame, conn, allConns);
    expect(effect.toSender[0]?.t).toBe('error');
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('not_hello');
    expect(e.id).toBe(id);
  });

  it('error bad_frame on malformed JSON', async () => {
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip1');
    const effect = await room.onMessage('c1', 'not json', conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('bad_frame');
  });

  it('error bad_name on invalid name', async () => {
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const frame = await buildHelloFrame(kp, 'A B', clock.now());
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('bad_name');
  });

  it('error reserved_name for non-maintainer', async () => {
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const frame = await buildHelloFrame(kp, 'admin', clock.now());
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('reserved_name');
  });

  it('maintainer can use reserved name', async () => {
    const maintainerRoom = new Room(store, makeConfig({ maintainerKeys: [kp.pubkey] }), clock);
    const allConns = new Map<string, ConnRecord>();
    const conn = maintainerRoom.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const frame = await buildHelloFrame(kp, 'admin', clock.now());
    const effect = await maintainerRoom.onMessage('c1', frame, conn, allConns);
    expect(effect.toSender[0]?.t).toBe('welcome');
  });

  it('error bad_signature on wrong sig', async () => {
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const badSig = '0'.repeat(128);
    const frame = JSON.stringify({ t: 'hello', v: 1, pubkey: kp.pubkey, name: 'alice', ts: clock.now(), sig: badSig });
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('bad_signature');
  });

  it('error stale_timestamp', async () => {
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const frame = await buildHelloFrame(kp, 'alice', clock.now() - 300_000);
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('stale_timestamp');
  });

  it('error closed for non-maintainer in closed mode', async () => {
    await store.setRoomMode('closed');
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const frame = await buildHelloFrame(kp, 'alice', clock.now());
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('closed');
    expect(effect.toClose).toContain('c1');
  });

  it('maintainer can hello in closed mode', async () => {
    await store.setRoomMode('closed');
    const mRoom = new Room(store, makeConfig({ maintainerKeys: [kp.pubkey] }), clock);
    const allConns = new Map<string, ConnRecord>();
    const conn = mRoom.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const frame = await buildHelloFrame(kp, 'alice', clock.now());
    const effect = await mRoom.onMessage('c1', frame, conn, allConns);
    expect(effect.toSender[0]?.t).toBe('welcome');
  });

  it('error banned on key ban', async () => {
    await store.addBan(kp.pubkey, 'ip1');
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip1');
    allConns.set('c1', conn);
    const frame = await buildHelloFrame(kp, 'alice', clock.now());
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('banned');
    expect(effect.toClose).toContain('c1');
  });

  it('error banned on ip ban', async () => {
    await store.addBan('a'.repeat(64), 'ip-bad');
    const allConns = new Map<string, ConnRecord>();
    const conn = room.onConnect('c1', 'ip-bad');
    allConns.set('c1', conn);
    const frame = await buildHelloFrame(kp, 'alice', clock.now());
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('banned');
  });

  it('name_change_too_soon on rapid rename', async () => {
    const allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp, 'alice', store, clock, allConns);
    const c1 = room.onConnect('c1', 'ip1');
    // Advance slightly (less than 24h) and try different name
    clock.advance(1_000);
    const frame2 = await buildHelloFrame(kp, 'alicia', clock.now());
    const effect2 = await room.onMessage('c1', frame2, c1, allConns);
    const e = effect2.toSender[0] as Extract<typeof effect2.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('name_change_too_soon');
    expect(e.retryAfterMs).toBeGreaterThan(0);
  });

  it('allows rename after 24h', async () => {
    const allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp, 'alice', store, clock, allConns);
    clock.advance(24 * 60 * 60 * 1000 + 1_000);
    const c1 = room.onConnect('c1', 'ip1');
    const frame2 = await buildHelloFrame(kp, 'alicia', clock.now());
    const effect2 = await room.onMessage('c1', frame2, c1, allConns);
    expect(effect2.toSender[0]?.t).toBe('welcome');
  });
});

describe('Room post checks (order)', () => {
  let store: MemoryRelayStore;
  let clock: ReturnType<typeof makeClock>;
  let room: Room;
  let kp: StoredKeyPair;
  let allConns: Map<string, ConnRecord>;

  beforeEach(async () => {
    store = new MemoryRelayStore();
    clock = makeClock(1_700_000_000_000);
    room = new Room(store, makeConfig(), clock);
    kp = await generateKeyPair();
    allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp, 'alice', store, clock, allConns);
  });

  it('error bad_signature for invalid sig', async () => {
    const id = randomId();
    const badSig = '0'.repeat(128);
    const frame = JSON.stringify({ t: 'post', id, ts: clock.now(), text: 'hello', sig: badSig });
    const conn = allConns.get('c1')!;
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('bad_signature');
  });

  it('error stale_timestamp on post', async () => {
    const id = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, id, clock.now() - 300_000, 'alice', 'hello');
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('stale_timestamp');
  });

  it('error duplicate on repeated id', async () => {
    const id = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', 'hello');
    await room.onMessage('c1', frame, conn, allConns);
    clock.advance(100);
    const frame2 = await buildPostFrame(kp, id, clock.now(), 'alice', 'hello');
    const effect2 = await room.onMessage('c1', frame2, conn, allConns);
    const e = effect2.toSender[0] as Extract<typeof effect2.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('duplicate');
  });

  it('error too_long on oversized text', async () => {
    const id = randomId();
    const conn = allConns.get('c1')!;
    const text = 'a'.repeat(501);
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', text);
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('too_long');
  });

  it('error too_many_links on 3+ links', async () => {
    const id = randomId();
    const conn = allConns.get('c1')!;
    const text = 'see https://a.com and https://b.com and https://c.com';
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', text);
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('too_many_links');
  });

  it('error secret_detected on API key', async () => {
    const id = randomId();
    const conn = allConns.get('c1')!;
    const text = 'my key is sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', text);
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('secret_detected');
  });

  it('error readonly for non-maintainer in readonly mode', async () => {
    await store.setRoomMode('readonly');
    const id = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', 'hello');
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('readonly');
  });

  it('ban check precedes mode check (order: ban before mode)', async () => {
    await store.addBan(kp.pubkey, 'ip1');
    await store.setRoomMode('readonly');
    const id = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', 'hello');
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('banned');
    expect(e.id).toBe(id);
  });

  it('successful post: ack sent, msg broadcast, verifyMsg passes', async () => {
    const id = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', 'hello world');
    const effect = await room.onMessage('c1', frame, conn, allConns);
    expect(effect.toSender[0]?.t).toBe('ack');
    expect(effect.toBroadcast[0]?.t).toBe('msg');
    const msgFrame = effect.toBroadcast[0] as Extract<typeof effect.toBroadcast[0], { t: 'msg' }>;
    expect(await verifyMsg(msgFrame.m)).toBe(true);
  });

  it('error bad_frame when text not pre-sanitized', async () => {
    const id = randomId();
    const conn = allConns.get('c1')!;
    // Build a frame with unsanitized text (contains control char)
    const sk = await importPrivateKey(kp.privateKeyPkcs8);
    const text = 'hello\u0001world';
    const canonical = canonicalPost({ id, ts: clock.now(), name: 'alice', text });
    const sig = await sign(canonical, sk);
    const frame = JSON.stringify({ t: 'post', id, ts: clock.now(), text, sig });
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('bad_frame');
  });

  it('maintainer can post in readonly mode', async () => {
    const mkp = await generateKeyPair();
    const mRoom = new Room(store, makeConfig({ maintainerKeys: [mkp.pubkey] }), clock);
    const mAllConns = new Map<string, ConnRecord>();
    await doHello(mRoom, 'cm', mkp, 'maintainer', store, clock, mAllConns);
    await store.setRoomMode('readonly');
    const id = randomId();
    const conn = mAllConns.get('cm')!;
    const frame = await buildPostFrame(mkp, id, clock.now(), 'maintainer', 'important');
    const effect = await mRoom.onMessage('cm', frame, conn, mAllConns);
    expect(effect.toSender[0]?.t).toBe('ack');
  });

  it('maintainer post has badge maintainer', async () => {
    const mkp = await generateKeyPair();
    const mRoom = new Room(store, makeConfig({ maintainerKeys: [mkp.pubkey] }), clock);
    const mAllConns = new Map<string, ConnRecord>();
    await doHello(mRoom, 'cm', mkp, 'themod', store, clock, mAllConns);
    const id = randomId();
    const conn = mAllConns.get('cm')!;
    const frame = await buildPostFrame(mkp, id, clock.now(), 'themod', 'official notice');
    const effect = await mRoom.onMessage('cm', frame, conn, mAllConns);
    const msgFrame = effect.toBroadcast[0] as Extract<typeof effect.toBroadcast[0], { t: 'msg' }>;
    expect(msgFrame.m.badge).toBe('maintainer');
  });
});

describe('Room rate limits', () => {
  let store: MemoryRelayStore;
  let clock: ReturnType<typeof makeClock>;
  let room: Room;
  let kp: StoredKeyPair;
  let allConns: Map<string, ConnRecord>;

  beforeEach(async () => {
    store = new MemoryRelayStore();
    clock = makeClock(1_700_000_000_000);
    room = new Room(store, makeConfig(), clock);
    kp = await generateKeyPair();
    allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp, 'alice', store, clock, allConns);
  });

  it('allows burst of 5 posts', async () => {
    for (let i = 0; i < 5; i++) {
      clock.advance(1); // avoid duplicate ts issues
      const id = randomId();
      const conn = allConns.get('c1')!;
      const frame = await buildPostFrame(kp, id, clock.now(), 'alice', `msg ${i}`);
      const effect = await room.onMessage('c1', frame, conn, allConns);
      expect(effect.toSender[0]?.t).toBe('ack');
    }
  });

  it('rate_limited on 6th rapid post', async () => {
    for (let i = 0; i < 5; i++) {
      clock.advance(1);
      const id = randomId();
      const conn = allConns.get('c1')!;
      const frame = await buildPostFrame(kp, id, clock.now(), 'alice', `msg ${i}`);
      await room.onMessage('c1', frame, conn, allConns);
    }
    clock.advance(1);
    const id = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', 'one too many');
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterMs).toBeGreaterThan(0);
  });

  it('token refills after interval', async () => {
    for (let i = 0; i < 5; i++) {
      clock.advance(1);
      const id = randomId();
      const conn = allConns.get('c1')!;
      const frame = await buildPostFrame(kp, id, clock.now(), 'alice', `msg ${i}`);
      await room.onMessage('c1', frame, conn, allConns);
    }
    clock.advance(3_001); // 1 token refills after 3s
    const id = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', 'after refill');
    const effect = await room.onMessage('c1', frame, conn, allConns);
    expect(effect.toSender[0]?.t).toBe('ack');
  });

  it('new key gets 20/hr limit', async () => {
    // New key -- already registered in doHello above, firstSeenAt = clock base
    for (let i = 0; i < 20; i++) {
      clock.advance(4_000); // avoid token bucket limit (1/3s, burst 5)
      const id = randomId();
      const conn = allConns.get('c1')!;
      const frame = await buildPostFrame(kp, id, clock.now(), 'alice', `msg ${i}`);
      const effect = await room.onMessage('c1', frame, conn, allConns);
      expect(effect.toSender[0]?.t).toBe('ack');
    }
    clock.advance(4_000);
    const id = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', 'over limit');
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('rate_limited');
  });

  it('ip hash limit: 60 posts per minute', async () => {
    // Use 60 distinct keys all sharing one IP, each posting once.
    // This avoids the per-key token bucket (burst=5) while hitting the
    // per-ip sliding window (60/min). Keys are pre-registered as old so
    // the new-key hourly quota does not interfere.
    const store2 = new MemoryRelayStore();
    // Raise maxConnsPerIp so the 61 hellos from one IP are not blocked
    const room2 = new Room(store2, makeConfig({ maxConnsPerIp: 100 }), clock);
    const sharedIp = 'ip-shared';
    const allConns2 = new Map<string, ConnRecord>();
    const keys: StoredKeyPair[] = [];
    for (let i = 0; i < 61; i++) {
      const k = await generateKeyPair();
      keys.push(k);
      // Pre-register as old key so new-key quota won't fire
      await store2.upsertKeyRecord({ pubkey: k.pubkey, name: `u${i}`, firstSeenAt: clock.now() - 48 * 3600 * 1000, lastSeenAt: clock.now(), nameChangedAt: 0 });
      await doHello(room2, `c${i}`, k, `u${i}`, store2, clock, allConns2, sharedIp);
    }
    // First 60 posts should succeed
    for (let i = 0; i < 60; i++) {
      clock.advance(10); // tiny advance to avoid duplicate ts
      const k = keys[i]!;
      const id = randomId();
      const conn = allConns2.get(`c${i}`)!;
      const frame = await buildPostFrame(k, id, clock.now(), `u${i}`, `msg ${i}`);
      const effect = await room2.onMessage(`c${i}`, frame, conn, allConns2);
      expect(effect.toSender[0]?.t).toBe('ack');
    }
    // 61st post from the same IP should be rate_limited
    clock.advance(10);
    const k61 = keys[60]!;
    const id = randomId();
    const conn61 = allConns2.get('c60')!;
    const frame = await buildPostFrame(k61, id, clock.now(), 'u60', 'over ip limit');
    const effect = await room2.onMessage('c60', frame, conn61, allConns2);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('rate_limited');
  });
});

describe('Room presence', () => {
  let store: MemoryRelayStore;
  let clock: ReturnType<typeof makeClock>;
  let room: Room;

  beforeEach(() => {
    store = new MemoryRelayStore();
    clock = makeClock(1_700_000_000_000);
    room = new Room(store, makeConfig(), clock);
  });

  it('broadcasts presence when new unique key connects', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const allConns = new Map<string, ConnRecord>();

    // First hello
    await doHello(room, 'c1', kp1, 'alice', store, clock, allConns);

    // Second hello with different key
    const c2 = room.onConnect('c2', 'ip2');
    allConns.set('c2', c2);
    const frame2 = await buildHelloFrame(kp2, 'bob', clock.now());
    const effect2 = await room.onMessage('c2', frame2, c2, allConns);
    // Should broadcast presence = 2
    const pres = effect2.toBroadcast.find(f => f.t === 'presence') as { t: 'presence'; online: number } | undefined;
    expect(pres?.online).toBe(2);
  });

  it('two connections same key: presence stays at 1', async () => {
    const kp1 = await generateKeyPair();
    const allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp1, 'alice', store, clock, allConns);

    // Second connection same key
    clock.advance(1_000);
    const c2 = room.onConnect('c2', 'ip2');
    allConns.set('c2', c2);
    const frame2 = await buildHelloFrame(kp1, 'alice', clock.now());
    const effect2 = await room.onMessage('c2', frame2, c2, allConns);
    // No presence broadcast (same key already counted)
    const pres = effect2.toBroadcast.find(f => f.t === 'presence');
    expect(pres).toBeUndefined();
  });

  it('closing one of two sockets for the same key does not decrement presence', async () => {
    const kp = await generateKeyPair();
    const allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp, 'alice', store, clock, allConns);
    await doHello(room, 'c2', kp, 'alice', store, clock, allConns);
    const effect = await room.onClose('c1', allConns.get('c1')!, allConns);
    expect(effect.toBroadcast).toEqual([]);
  });

  it('broadcasts presence on close when key drops to 0', async () => {
    const kp1 = await generateKeyPair();
    const allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp1, 'alice', store, clock, allConns);
    const conn = allConns.get('c1')!;
    const effect = await room.onClose('c1', conn, allConns);
    const pres = effect.toBroadcast.find(f => f.t === 'presence') as { t: 'presence'; online: number } | undefined;
    expect(pres?.online).toBe(0);
  });
});

describe('Room backlog', () => {
  let store: MemoryRelayStore;
  let clock: ReturnType<typeof makeClock>;
  let room: Room;
  let kp: StoredKeyPair;

  beforeEach(async () => {
    store = new MemoryRelayStore();
    clock = makeClock(1_700_000_000_000);
    room = new Room(store, makeConfig(), clock);
    kp = await generateKeyPair();
  });

  it('welcome backlog contains posted messages in order', async () => {
    const allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp, 'alice', store, clock, allConns);
    // Post 3 messages
    for (let i = 0; i < 3; i++) {
      clock.advance(4_000);
      const id = randomId();
      const conn = allConns.get('c1')!;
      const frame = await buildPostFrame(kp, id, clock.now(), 'alice', `msg ${i}`);
      await room.onMessage('c1', frame, conn, allConns);
    }
    // Connect second client
    const kp2 = await generateKeyPair();
    clock.advance(1_000);
    const c2 = room.onConnect('c2', 'ip2');
    allConns.set('c2', c2);
    const frame2 = await buildHelloFrame(kp2, 'bob', clock.now());
    const effect2 = await room.onMessage('c2', frame2, c2, allConns);
    const welcome = effect2.toSender[0] as Extract<typeof effect2.toSender[0], { t: 'welcome' }>;
    expect(welcome.backlog.length).toBe(3);
    expect(welcome.backlog[0]?.text).toBe('msg 0');
    expect(welcome.backlog[2]?.text).toBe('msg 2');
  });

  it('deleted messages absent from backlog', async () => {
    const allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp, 'alice', store, clock, allConns);
    clock.advance(4_000);
    const id = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, id, clock.now(), 'alice', 'will be deleted');
    await room.onMessage('c1', frame, conn, allConns);
    await store.markDeleted(id);
    // Connect second client
    const kp2 = await generateKeyPair();
    clock.advance(1_000);
    const c2 = room.onConnect('c2', 'ip2');
    allConns.set('c2', c2);
    const hf = await buildHelloFrame(kp2, 'bob', clock.now());
    const effect2 = await room.onMessage('c2', hf, c2, allConns);
    const welcome = effect2.toSender[0] as Extract<typeof effect2.toSender[0], { t: 'welcome' }>;
    expect(welcome.backlog.length).toBe(0);
  });

  it('backlog capped at BACKLOG_SIZE', async () => {
    // Insert BACKLOG_SIZE + 5 messages directly
    for (let i = 0; i < BACKLOG_SIZE + 5; i++) {
      await store.insertMessage({ id: randomId(), ts: 1_700_000_000_000 + i, pubkey: kp.pubkey, name: 'alice', text: `msg ${i}`, sig: '0'.repeat(128) });
    }
    const backlog = await store.getBacklog(BACKLOG_SIZE);
    expect(backlog.length).toBe(BACKLOG_SIZE);
  });

  it('retention pruning removes old messages', async () => {
    const oldTs = 1_000_000;
    await store.insertMessage({ id: randomId(), ts: oldTs, pubkey: kp.pubkey, name: 'alice', text: 'old', sig: '0'.repeat(128) });
    await store.insertMessage({ id: randomId(), ts: clock.now(), pubkey: kp.pubkey, name: 'alice', text: 'new', sig: '0'.repeat(128) });
    await store.pruneOlderThan(clock.now() - 7 * 24 * 3600 * 1000);
    const backlog = await store.getBacklog(50);
    expect(backlog.every(m => m.ts >= clock.now() - 7 * 24 * 3600 * 1000)).toBe(true);
  });
});

describe('Room bans', () => {
  let store: MemoryRelayStore;
  let clock: ReturnType<typeof makeClock>;
  let room: Room;
  let kp: StoredKeyPair;
  let mkp: StoredKeyPair;
  let allConns: Map<string, ConnRecord>;

  beforeEach(async () => {
    store = new MemoryRelayStore();
    clock = makeClock(1_700_000_000_000);
    mkp = await generateKeyPair();
    room = new Room(store, makeConfig({ maintainerKeys: [mkp.pubkey] }), clock);
    kp = await generateKeyPair();
    allConns = new Map<string, ConnRecord>();
    await doHello(room, 'mod', mkp, 'themod', store, clock, allConns);
    await doHello(room, 'c1', kp, 'alice', store, clock, allConns);
  });

  it('refuses a captured ban after unban and Room recreation, including future timestamps', async () => {
    const conn = allConns.get('mod')!;
    const id = randomId();
    const frame = await buildAdminFrame(mkp, id, clock.now() + 120_000, 'ban', kp.pubkey);
    await room.onMessage('mod', frame, conn, allConns);
    const unban = await buildAdminFrame(mkp, randomId(), clock.now(), 'unban', kp.pubkey);
    await room.onMessage('mod', unban, conn, allConns);
    clock.advance(120_001);
    room = new Room(store, makeConfig({ maintainerKeys: [mkp.pubkey] }), clock);
    await room.onAlarm();
    const replay = await room.onMessage('mod', frame, conn, allConns);
    expect(replay.toSender[0]).toMatchObject({ code: 'duplicate', id });
    expect(await store.isBannedKey(kp.pubkey)).toBe(false);
  });

  it('admin ban closes live connections for target key', async () => {
    const conn = allConns.get('mod')!;
    const id = randomId();
    const frame = await buildAdminFrame(mkp, id, clock.now(), 'ban', kp.pubkey);
    const effect = await room.onMessage('mod', frame, conn, allConns);
    expect(effect.toClose).toContain('c1');
    expect(effect.toSender).toContainEqual({ t: 'ack', id });
    expect(effect.toBroadcast.some(f => f.t === 'error')).toBe(false);
    expect(effect.toConnections).toEqual([{ connId: 'c1',
      frame: { t: 'error', code: 'banned', message: 'You have been banned' } }]);
  });

  it('admin ban blocks reconnect by key', async () => {
    const conn = allConns.get('mod')!;
    const id = randomId();
    const frame = await buildAdminFrame(mkp, id, clock.now(), 'ban', kp.pubkey);
    await room.onMessage('mod', frame, conn, allConns);
    // Attempt reconnect
    const c2 = room.onConnect('c2', 'ip1');
    allConns.set('c2', c2);
    const hf = await buildHelloFrame(kp, 'alice', clock.now());
    const effect2 = await room.onMessage('c2', hf, c2, allConns);
    const e = effect2.toSender[0] as Extract<typeof effect2.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('banned');
  });

  it('admin ban blocks reconnect by ip hash', async () => {
    // The ban should capture the ip hash of the live connection (ip1)
    const conn = allConns.get('mod')!;
    const id = randomId();
    const frame = await buildAdminFrame(mkp, id, clock.now(), 'ban', kp.pubkey);
    await room.onMessage('mod', frame, conn, allConns);
    // Different key, same ip
    const kp3 = await generateKeyPair();
    const c3 = room.onConnect('c3', 'ip1');
    allConns.set('c3', c3);
    const hf = await buildHelloFrame(kp3, 'charlie', clock.now());
    const effect3 = await room.onMessage('c3', hf, c3, allConns);
    const e = effect3.toSender[0] as Extract<typeof effect3.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('banned');
  });

  it('admin unban lifts key and ip bans', async () => {
    // Ban first
    const conn = allConns.get('mod')!;
    let id = randomId();
    const banFrame = await buildAdminFrame(mkp, id, clock.now(), 'ban', kp.pubkey);
    await room.onMessage('mod', banFrame, conn, allConns);
    // Unban
    clock.advance(100);
    id = randomId();
    const unbanFrame = await buildAdminFrame(mkp, id, clock.now(), 'unban', kp.pubkey);
    await room.onMessage('mod', unbanFrame, conn, allConns);
    // Reconnect should succeed
    clock.advance(100);
    const c2 = room.onConnect('c2', 'ip1');
    allConns.set('c2', c2);
    const hf = await buildHelloFrame(kp, 'alice', clock.now());
    const effect2 = await room.onMessage('c2', hf, c2, allConns);
    expect(effect2.toSender[0]?.t).toBe('welcome');
  });

  it('error forbidden for non-maintainer admin', async () => {
    const conn = allConns.get('c1')!;
    const id = randomId();
    const frame = await buildAdminFrame(kp, id, clock.now(), 'ban', mkp.pubkey);
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('forbidden');
    expect(e.id).toBe(id);
  });

  it('unbans an offline key that has no captured address', async () => {
    const offline = (await generateKeyPair()).pubkey;
    await store.addBan(offline, '');
    await store.removeBan(offline);
    expect(await store.isBannedKey(offline)).toBe(false);
  });
});

describe('Room reports', () => {
  let store: MemoryRelayStore;
  let clock: ReturnType<typeof makeClock>;
  let room: Room;
  let kp: StoredKeyPair;
  let allConns: Map<string, ConnRecord>;
  let targetMsgId: string;

  beforeEach(async () => {
    store = new MemoryRelayStore();
    clock = makeClock(1_700_000_000_000);
    room = new Room(store, makeConfig(), clock);
    kp = await generateKeyPair();
    allConns = new Map<string, ConnRecord>();
    await doHello(room, 'c1', kp, 'alice', store, clock, allConns);
    // Post a message to report
    clock.advance(4_000);
    targetMsgId = randomId();
    const conn = allConns.get('c1')!;
    const frame = await buildPostFrame(kp, targetMsgId, clock.now(), 'alice', 'reportable');
    await room.onMessage('c1', frame, conn, allConns);
  });

  it('refuses replayed signed reports after Room recreation', async () => {
    const reporter = await generateKeyPair();
    const conn = await doHello(room, 'r', reporter, 'bob', store, clock, allConns);
    const id = randomId();
    const frame = await buildReportFrame(reporter, id, clock.now(), targetMsgId);
    await room.onMessage('r', frame, conn, allConns);
    room = new Room(store, makeConfig(), clock);
    const replay = await room.onMessage('r', frame, conn, allConns);
    expect(replay.toSender[0]).toMatchObject({ code: 'duplicate', id });
    expect(await store.countReporters(targetMsgId)).toBe(1);
  });

  it('error forbidden when reporting own message', async () => {
    const conn = allConns.get('c1')!;
    clock.advance(1_000);
    const frame = await buildReportFrame(kp, randomId(), clock.now(), targetMsgId);
    const effect = await room.onMessage('c1', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('forbidden');
    expect(e.message).toBe('Cannot report your own message');
  });

  it('error unknown_target for nonexistent message', async () => {
    const kp2 = await generateKeyPair();
    await doHello(room, 'c2', kp2, 'bob', store, clock, allConns);
    const conn = allConns.get('c2')!;
    clock.advance(1_000);
    const frame = await buildReportFrame(kp2, randomId(), clock.now(), randomId());
    const effect = await room.onMessage('c2', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('unknown_target');
  });

  it('at REPORT_THRESHOLD reports: message deleted, deleted broadcast', async () => {
    // Create REPORT_THRESHOLD different reporters
    const reporters: StoredKeyPair[] = [];
    for (let i = 0; i < REPORT_THRESHOLD; i++) {
      const rkp = await generateKeyPair();
      reporters.push(rkp);
      await doHello(room, `r${i}`, rkp, `reporter${i}`, store, clock, allConns);
    }
    let lastEffect = null;
    for (let i = 0; i < REPORT_THRESHOLD; i++) {
      const rkp = reporters[i]!;
      const conn = allConns.get(`r${i}`)!;
      clock.advance(1_000);
      const frame = await buildReportFrame(rkp, randomId(), clock.now(), targetMsgId);
      lastEffect = await room.onMessage(`r${i}`, frame, conn, allConns);
    }
    expect(lastEffect?.toBroadcast.some(f => f.t === 'deleted')).toBe(true);
    // Message absent from backlog
    const backlog = await store.getBacklog(50);
    expect(backlog.some(m => m.id === targetMsgId)).toBe(false);
  });

  it('error unknown_target for already-deleted message', async () => {
    await store.markDeleted(targetMsgId);
    const kp2 = await generateKeyPair();
    await doHello(room, 'c2', kp2, 'bob', store, clock, allConns);
    const conn = allConns.get('c2')!;
    clock.advance(1_000);
    const frame = await buildReportFrame(kp2, randomId(), clock.now(), targetMsgId);
    const effect = await room.onMessage('c2', frame, conn, allConns);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('unknown_target');
  });
});

describe('Room mode admin', () => {
  let store: MemoryRelayStore;
  let clock: ReturnType<typeof makeClock>;
  let room: Room;
  let mkp: StoredKeyPair;
  let allConns: Map<string, ConnRecord>;

  beforeEach(async () => {
    store = new MemoryRelayStore();
    clock = makeClock(1_700_000_000_000);
    mkp = await generateKeyPair();
    room = new Room(store, makeConfig({ maintainerKeys: [mkp.pubkey] }), clock);
    allConns = new Map<string, ConnRecord>();
    await doHello(room, 'mod', mkp, 'themod', store, clock, allConns);
  });

  it('admin mode broadcasts mode change', async () => {
    const conn = allConns.get('mod')!;
    const frame = await buildAdminFrame(mkp, randomId(), clock.now(), 'mode', 'readonly');
    const effect = await room.onMessage('mod', frame, conn, allConns);
    const modeFrame = effect.toBroadcast.find(f => f.t === 'mode') as { t: 'mode'; mode: string } | undefined;
    expect(modeFrame?.mode).toBe('readonly');
  });

  it('admin delete marks message deleted and broadcasts', async () => {
    const kp2 = await generateKeyPair();
    await doHello(room, 'c1', kp2, 'alice', store, clock, allConns);
    clock.advance(4_000);
    const msgId = randomId();
    const conn1 = allConns.get('c1')!;
    const pf = await buildPostFrame(kp2, msgId, clock.now(), 'alice', 'delete me');
    await room.onMessage('c1', pf, conn1, allConns);
    // Admin delete
    clock.advance(100);
    const conn = allConns.get('mod')!;
    const frame = await buildAdminFrame(mkp, randomId(), clock.now(), 'delete', msgId);
    const effect = await room.onMessage('mod', frame, conn, allConns);
    const del = effect.toBroadcast.find(f => f.t === 'deleted') as { t: 'deleted'; id: string } | undefined;
    expect(del?.id).toBe(msgId);
  });

  it('forcedMode overrides stored mode', async () => {
    await store.setRoomMode('open');
    const frozenRoom = new Room(store, makeConfig({ maintainerKeys: [mkp.pubkey], forcedMode: 'closed' }), clock);
    const kp2 = await generateKeyPair();
    const ac = new Map<string, ConnRecord>();
    const c = frozenRoom.onConnect('c1', 'ip1');
    ac.set('c1', c);
    const hf = await buildHelloFrame(kp2, 'bob', clock.now());
    const effect = await frozenRoom.onMessage('c1', hf, c, ac);
    const e = effect.toSender[0] as Extract<typeof effect.toSender[0], { t: 'error' }>;
    expect(e.code).toBe('closed');
  });
});

describe('Room ping/pong', () => {
  it('responds with pong', async () => {
    const store = new MemoryRelayStore();
    const clock = makeClock();
    const room = new Room(store, makeConfig(), clock);
    const conn = room.onConnect('c1', 'ip1');
    const allConns = new Map<string, ConnRecord>();
    allConns.set('c1', conn);
    const effect = await room.onMessage('c1', JSON.stringify({ t: 'ping', n: 42 }), conn, allConns);
    expect(effect.toSender[0]).toEqual({ t: 'pong', n: 42 });
  });
});

describe('Room hibernation simulation', () => {
  it('resumes session correctly after fresh Room instance over same store', async () => {
    const store = new MemoryRelayStore();
    const clock = makeClock(1_700_000_000_000);
    const kp1 = await generateKeyPair();

    // Session 1: hello and post
    const room1 = new Room(store, makeConfig(), clock);
    const allConns1 = new Map<string, ConnRecord>();
    await doHello(room1, 'c1', kp1, 'alice', store, clock, allConns1);
    clock.advance(4_000);
    const msgId = randomId();
    const conn1 = allConns1.get('c1')!;
    const pf = await buildPostFrame(kp1, msgId, clock.now(), 'alice', 'pre-hibernate msg');
    await room1.onMessage('c1', pf, conn1, allConns1);

    // --- Simulate hibernation: recreate Room, restore conn record ---
    const savedConn = allConns1.get('c1')!; // the persisted attachment
    const room2 = new Room(store, makeConfig(), clock);
    const allConns2 = new Map<string, ConnRecord>();
    allConns2.set('c1', savedConn); // restore from persisted attachment

    // Post again -- should work because conn record says helloOk:true
    clock.advance(4_000);
    const msgId2 = randomId();
    const pf2 = await buildPostFrame(kp1, msgId2, clock.now(), 'alice', 'post-hibernate msg');
    const effect = await room2.onMessage('c1', pf2, savedConn, allConns2);
    expect(effect.toSender[0]?.t).toBe('ack');

    // New client connecting to room2 sees both messages in backlog
    const kp2 = await generateKeyPair();
    clock.advance(1_000);
    const c2 = room2.onConnect('c2', 'ip2');
    allConns2.set('c2', c2);
    const hf = await buildHelloFrame(kp2, 'bob', clock.now());
    const welcomeEffect = await room2.onMessage('c2', hf, c2, allConns2);
    const welcome = welcomeEffect.toSender[0] as Extract<typeof welcomeEffect.toSender[0], { t: 'welcome' }>;
    expect(welcome.backlog.length).toBe(2);
    expect(welcome.backlog[0]?.text).toBe('pre-hibernate msg');
    expect(welcome.backlog[1]?.text).toBe('post-hibernate msg');
  });
});

describe('countDistinctKeys helper', () => {
  it('counts distinct keys from hello\'d conns', () => {
    const m = new Map<string, ConnRecord>([
      ['c1', { pubkey: 'aaa', name: 'a', ipHash: 'ip1', helloOk: true }],
      ['c2', { pubkey: 'aaa', name: 'a', ipHash: 'ip2', helloOk: true }],
      ['c3', { pubkey: 'bbb', name: 'b', ipHash: 'ip3', helloOk: true }],
      ['c4', { pubkey: null, name: null, ipHash: 'ip4', helloOk: false }],
    ]);
    expect(countDistinctKeys(m)).toBe(2);
  });
});
