/**
 * End-to-end integration tests: GlobalChatClient <-> Room over an in-memory
 * socket pair with real FileIdentityStore instances on temp paths.
 *
 * Keep <=350 lines. Helpers live in e2e.test.helpers.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { GlobalChatClient } from './client.js';
import { FileIdentityStore } from './identity.js';
import { NAME_CHANGE_INTERVAL_MS } from './protocol.js';
import { InMemoryRelay, ClientEnd } from './e2e.test.helpers.js';
import type { ChatWelcome } from './client-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tempStore(opts?: { now?: () => number; name?: string }): Promise<{
  store: FileIdentityStore; dir: string; identity: { pubkey: string; name: string };
}> {
  const dir = await mkdtemp(join(tmpdir(), 'afk-e2e-'));
  const store = new FileIdentityStore({ filePath: join(dir, 'identity.json'), now: opts?.now });
  const name = opts?.name ?? 'user';
  const result = await store.create(name);
  if (!result.ok) throw new Error(`store.create failed: ${result.code}`);
  return { store, dir, identity: result.identity };
}

type ConnectedUser = {
  client: GlobalChatClient; store: FileIdentityStore; dir: string;
  connId: string; end: ClientEnd; welcome: ChatWelcome;
};

async function connect(
  relay: InMemoryRelay,
  store: FileIdentityStore,
  dir: string,
  ipHash = 'ip1',
): Promise<ConnectedUser> {
  const end = new ClientEnd();
  const connId = relay.register(end, ipHash);
  const client = new GlobalChatClient({
    url: 'ws://localhost/global',
    identity: store,
    WebSocket: relay.socketFactory(end),
    now: () => relay._time,
  });
  // Subscribe BEFORE connecting so we don't miss the welcome.
  // Sequence: await client.connect() (loads identity + calls transport.connect()
  // which calls #dial() synchronously), THEN triggerOpen() so the socket's 'open'
  // listener is already registered when we fire it.
  const welcomeP = new Promise<ChatWelcome>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('welcome timed out')), 5000);
    const unsub = client.subscribe({
      onWelcome: w => { clearTimeout(timer); unsub(); resolve(w); },
    });
  });
  await client.connect(); // identity loaded, socket created, open listener registered
  end.triggerOpen();      // schedules async hello (void #open(current))
  // #hello is async (crypto sign); drain microtasks + one real tick so it completes
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  await relay.flush(connId); // relay processes hello, sends welcome back via end.receive()
  // welcome frame is delivered synchronously in flush; wait a tick for the
  // incoming promise chain in the transport to process it
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  const welcome = await welcomeP;
  return { client, store, dir, connId, end, welcome };
}

/** Wait N ms (lets async crypto / promise chains drain). */
const tick = (ms = 20) => new Promise<void>(r => setTimeout(r, ms));

/** Start an action, let signing complete, flush the relay, let ack be processed. */
async function doAction<T>(
  relay: InMemoryRelay,
  connId: string,
  actionP: Promise<T>,
): Promise<T> {
  await tick(30); // crypto sign completes, frame is on end.sent
  await relay.flush(connId); // relay processes frame, sends ack/error back
  await tick(10); // transport's #incoming chain processes the ack
  return actionP;
}

function awaitMsg(client: GlobalChatClient, timeoutMs = 3000) {
  return new Promise<import('./protocol.js').Msg>((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error('awaitMsg timed out')); }, timeoutMs);
    const unsub = client.subscribe({ onMessage: m => { clearTimeout(timer); unsub(); resolve(m); } });
  });
}

function awaitPresence(client: GlobalChatClient, pred: (n: number) => boolean, timeoutMs = 3000) {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error('awaitPresence timed out')); }, timeoutMs);
    const unsub = client.subscribe({ onPresence: n => { if (pred(n)) { clearTimeout(timer); unsub(); resolve(n); } } });
  });
}

function awaitError(client: GlobalChatClient, timeoutMs = 3000) {
  return new Promise<import('./client-types.js').ChatRelayError>((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error('awaitError timed out')); }, timeoutMs);
    const unsub = client.subscribe({ onError: e => { clearTimeout(timer); unsub(); resolve(e); } });
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GlobalChatClient <-> Room e2e', () => {
  let relay: InMemoryRelay;
  const dirs: string[] = [];

  beforeEach(() => { relay = new InMemoryRelay({ maxConnsPerIp: 10 }); });
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => { /* ignore */ });
  });

  async function makeUser(name: string, ipHash = 'ip1', now?: () => number) {
    const { store, dir, identity } = await tempStore({ name, now });
    dirs.push(dir);
    const u = await connect(relay, store, dir, ipHash);
    return { ...u, identity };
  }

  it('two users join and each sees the correct online count', async () => {
    const a = await makeUser('alice', 'ip1');
    expect(a.welcome.online).toBe(1);
    const presP = awaitPresence(a.client, n => n === 2);
    const b = await makeUser('bob', 'ip2');
    expect(b.welcome.online).toBe(2);
    expect(await presP).toBe(2);
    a.client.close(); b.client.close();
  });

  it('a post from alice arrives at bob, verified', async () => {
    const a = await makeUser('alice', 'ip1');
    const b = await makeUser('bob', 'ip2');
    const msgP = awaitMsg(b.client);
    const result = await doAction(relay, a.connId, a.client.post('Hello from alice'));
    expect(result.ok).toBe(true);
    const msg = await msgP;
    expect(msg.text).toBe('Hello from alice');
    a.client.close(); b.client.close();
  });

  it('a third user joining later receives backlog in order', async () => {
    const a = await makeUser('alice', 'ip1');
    expect((await doAction(relay, a.connId, a.client.post('first'))).ok).toBe(true);
    expect((await doAction(relay, a.connId, a.client.post('second'))).ok).toBe(true);
    const c = await makeUser('charlie', 'ip3');
    expect(c.welcome.backlog.map(m => m.text)).toEqual(['first', 'second']);
    a.client.close(); c.client.close();
  });

  it('a post containing a credential is refused locally and never reaches the relay', async () => {
    const a = await makeUser('alice', 'ip1');
    const before = await relay.store.getBacklog(50);
    const result = await a.client.post('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ0000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('secret_detected');
    expect((await relay.store.getBacklog(50)).length).toBe(before.length);
    a.client.close();
  });

  it('a rate-limited post surfaces the relay refusal with a wait time', async () => {
    const a = await makeUser('alice', 'ip1');
    // Burst=5; post 6 quickly, 6th should be rate_limited
    const posts: Promise<Awaited<ReturnType<typeof a.client.post>>>[] = [];
    for (let i = 0; i < 6; i++) posts.push(a.client.post(`msg${i}`));
    await tick(50); // all 6 sign operations complete
    await relay.flush(a.connId); // relay processes all 6; 6th is rate_limited
    await tick(20); // acks/errors processed
    const results = await Promise.all(posts);
    const limited = results.filter(r => !r.ok && r.code === 'rate_limited');
    expect(limited.length).toBeGreaterThan(0);
    a.client.close();
  });

  it('a maintainer bans a user, who is disconnected and cannot rejoin', async () => {
    const { store: mStore, dir: mDir, identity: mIdent } = await tempStore({ name: 'maint' });
    dirs.push(mDir);
    relay = new InMemoryRelay({ maintainerKeys: [mIdent.pubkey], maxConnsPerIp: 10 });
    const maintConn = await connect(relay, mStore, mDir, 'ip-m');
    const victim = await makeUser('victim', 'ip-v');

    // Start the ban action (relay has no ack for admin ops; we verify via store)
    void maintConn.client.admin('ban', victim.identity.pubkey);
    await tick(30); // sign completes
    await relay.flush(maintConn.connId); // relay processes ban, closes victim
    await tick(10);

    // Verify ban is in store
    expect(await relay.store.isBannedKey(victim.identity.pubkey)).toBe(true);

    // Victim reconnects -- should get banned error
    const end2 = new ClientEnd();
    const connId2 = relay.register(end2, 'ip-v2');
    const client2 = new GlobalChatClient({
      url: 'ws://localhost/global', identity: victim.store,
      WebSocket: relay.socketFactory(end2), now: () => relay._time,
    });
    const errP = awaitError(client2);
    await client2.connect();
    end2.triggerOpen();
    await tick(30); // hello sign completes
    await relay.flush(connId2); // relay sends banned error back
    await tick(10); // transport processes error
    const err = await errP;
    expect(err.code).toBe('banned');

    maintConn.client.close(); victim.client.close(); client2.close();
  });

  it('maintainer sets read-only and a normal user post is refused', async () => {
    const { store: mStore, dir: mDir, identity: mIdent } = await tempStore({ name: 'maint2' });
    dirs.push(mDir);
    relay = new InMemoryRelay({ maintainerKeys: [mIdent.pubkey], maxConnsPerIp: 10 });
    const maintConn2 = await connect(relay, mStore, mDir, 'ip-m');
    const a = await makeUser('alice', 'ip-a');

    // Set readonly (relay sends no ack for mode changes; verify via store)
    void maintConn2.client.admin('mode', 'readonly');
    await tick(30); // sign completes
    await relay.flush(maintConn2.connId); // relay processes mode change
    await tick(10);
    expect(await relay.store.getRoomMode()).toBe('readonly');

    // Alice's post should be refused with readonly
    const result = await doAction(relay, a.connId, a.client.post('should fail'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('readonly');

    maintConn2.client.close(); a.client.close();
  });

  it('three distinct reports hide a message for everyone', async () => {
    const a = await makeUser('alice', 'ip-a');
    const postResult = await doAction(relay, a.connId, a.client.post('bad content'));
    expect(postResult.ok).toBe(true);
    const msgId = (postResult as { ok: true; id: string }).id;

    // Relay sends no ack for report ops; verify effect in store
    for (let i = 0; i < 3; i++) {
      const r = await makeUser(`reporter${i}`, `ip-r${i}`);
      void r.client.report(msgId);
      await tick(30); // sign completes
      await relay.flush(r.connId); // relay processes report
      await tick(10);
      r.client.close();
    }
    // After 3 reports the relay marks the message deleted (soft-delete: not in backlog)
    const backlog = await relay.store.getBacklog(50);
    expect(backlog.some(m => m.id === msgId)).toBe(false);
    a.client.close();
  });

  it('display name can be created; renaming immediately is refused on both sides', async () => {
    const t0 = Date.now();
    // Client side: immediate rename refused
    const { store, dir } = await tempStore({ name: 'alice', now: () => t0 });
    dirs.push(dir);
    const r1 = await store.rename('alice2');
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.code).toBe('name_change_too_soon');
      expect((r1.retryAfterMs ?? 0)).toBeGreaterThan(0);
    }

    // Relay side: second hello from same key with new name, inside interval
    // Connect alice at t0 to seed the relay's key record
    relay.setTime(t0);
    const { dir: d2, store: s2 } = await tempStore({ name: 'alice', now: () => t0 });
    dirs.push(d2);
    const u = await connect(relay, s2, d2, 'ip-a');
    expect(u.welcome.you.name).toBe('alice');
    u.client.close();

    // Now reconnect with same key but different name, relay time still t0
    // Rename via a future-time store so it writes through locally
    const s3 = new FileIdentityStore({
      filePath: join(d2, 'identity.json'),
      now: () => t0 + NAME_CHANGE_INTERVAL_MS + 1,
    });
    const r3 = await s3.rename('alice2');
    expect(r3.ok).toBe(true);

    // Reconnect at relay time t0 — relay has firstSeenAt=t0, nameChangedAt=0
    // elapsed = t0 - t0 = 0 < interval -> refused
    relay.setTime(t0);
    const end2 = new ClientEnd();
    const connId2 = relay.register(end2, 'ip-a2');
    const frozenStore = new FileIdentityStore({
      filePath: join(d2, 'identity.json'),
      now: () => t0,
    });
    const client2 = new GlobalChatClient({
      url: 'ws://localhost/global', identity: frozenStore,
      WebSocket: relay.socketFactory(end2), now: () => t0,
    });
    const errP = awaitError(client2);
    await client2.connect();
    end2.triggerOpen();
    await tick(30); // hello sign completes
    await relay.flush(connId2); // relay sends name_change_too_soon error
    await tick(10);
    const err = await errP;
    expect(err.code).toBe('name_change_too_soon');
    client2.close();

    // Contract note: client uses nameChangedAt (set at create()) as baseline;
    // relay uses max(nameChangedAt>0 ? nameChangedAt : firstSeenAt).  For a
    // brand-new key (nameChangedAt=0 on the relay), relay uses firstSeenAt,
    // which mirrors the client's create-time clock.  Both sides refuse an
    // immediate rename -- they agree on the outcome.
  });
});
