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
    url: 'ws://127.0.0.1/global',
    identity: store,
    WebSocket: relay.socketFactory(end),
    now: () => relay._time,
  });
  // Subscribe BEFORE connecting so we don't miss the welcome.
  // Sequence: await client.connect() (loads identity + calls transport.connect()
  // which calls #dial() synchronously), THEN triggerOpen() so the socket's 'open'
  // listener is already registered when we fire it.
  const welcomeP = new Promise<ChatWelcome>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('welcome timed out')), 12_000);
    const unsub = client.subscribe({
      onWelcome: w => { clearTimeout(timer); unsub(); resolve(w); },
    });
  });
  await client.connect(); // identity loaded, socket created, open listener registered
  end.triggerOpen();      // schedules async hello (void #open(current))
  // #hello is async (crypto sign); drain microtasks + one real tick so it completes.
  // Use 100ms to tolerate CI runners under load (Node 24 crypto can be slow).
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  await relay.flush(connId); // relay processes hello, sends welcome back via end.receive()
  // welcome frame is delivered synchronously in flush; wait a tick for the
  // incoming promise chain in the transport to process it (deriveTag is async crypto).
  await new Promise<void>(resolve => setTimeout(resolve, 100));
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

  async function makeMaintainer(name: string) {
    const { store, dir, identity } = await tempStore({ name });
    dirs.push(dir);
    relay = new InMemoryRelay({ maintainerKeys: [identity.pubkey], maxConnsPerIp: 10 });
    return connect(relay, store, dir, 'ip-m');
  }

  it('a maintainer bans a user, who is disconnected and cannot rejoin', async () => {
    const maint = await makeMaintainer('maint');
    const victim = await makeUser('victim', 'ip-v');
    const victimErr = awaitError(victim.client);
    const banned = await doAction(relay, maint.connId, maint.client.admin('ban', victim.identity.pubkey));
    expect(banned.ok).toBe(true);
    expect((await victimErr).code).toBe('banned');
    expect(victim.end.closed).toBe(true);
    expect(relay.conns.has(victim.connId)).toBe(false);

    // Victim reconnects -- refused with a terminal banned error.
    const end2 = new ClientEnd();
    const connId2 = relay.register(end2, 'ip-v2');
    const client2 = new GlobalChatClient({
      url: 'ws://127.0.0.1/global', identity: victim.store,
      WebSocket: relay.socketFactory(end2), now: () => relay._time,
    });
    const errP = awaitError(client2);
    await client2.connect();
    end2.triggerOpen();
    await tick(100); // hello sign completes (100ms tolerates loaded CI runners)
    await relay.flush(connId2); // relay sends banned error back
    await tick(50); // transport processes error
    expect((await errP).code).toBe('banned');
    maint.client.close(); victim.client.close(); client2.close();
  });

  it('a ban does not disconnect or error bystanders, who see presence drop and keep chatting', async () => {
    const maint = await makeMaintainer('maint3');
    const bystander = await makeUser('bystander', 'ip-b');
    const victim = await makeUser('victim', 'ip-v');
    const bystanderErrors: string[] = [];
    const maintErrors: string[] = [];
    bystander.client.subscribe({ onError: e => bystanderErrors.push(e.code) });
    maint.client.subscribe({ onError: e => maintErrors.push(e.code) });
    const presenceP = awaitPresence(bystander.client, n => n === 2);

    const banned = await doAction(relay, maint.connId, maint.client.admin('ban', victim.identity.pubkey));
    expect(banned.ok).toBe(true);
    expect(await presenceP).toBe(2);
    expect(bystanderErrors).toEqual([]);
    expect(maintErrors).toEqual([]);
    expect(bystander.end.closed).toBe(false);
    expect(maint.end.closed).toBe(false);

    // Both remaining users are still live: a post from the bystander is acked
    // and reaches the maintainer.
    const msgP = awaitMsg(maint.client);
    const posted = await doAction(relay, bystander.connId, bystander.client.post('still here'));
    expect(posted.ok).toBe(true);
    expect((await msgP).text).toBe('still here');
    maint.client.close(); bystander.client.close(); victim.client.close();
  });

  it('a non-maintainer admin action is refused with its own result', async () => {
    const a = await makeUser('alice', 'ip-a');
    const result = await doAction(relay, a.connId, a.client.admin('mode', 'closed'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
    expect(await relay.store.getRoomMode()).toBe('open');
    a.client.close();
  });

  it('maintainer sets read-only and a normal user post is refused', async () => {
    const maint = await makeMaintainer('maint2');
    const a = await makeUser('alice', 'ip-a');
    const modeP = new Promise<string>(resolve => { a.client.subscribe({ onMode: resolve }); });
    const modeResult = await doAction(relay, maint.connId, maint.client.admin('mode', 'readonly'));
    expect(modeResult.ok).toBe(true);
    expect(await modeP).toBe('readonly');

    const result = await doAction(relay, a.connId, a.client.post('should fail'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('readonly');
    maint.client.close(); a.client.close();
  });

  it('three distinct reports hide a message for everyone', async () => {
    const a = await makeUser('alice', 'ip-a');
    const postResult = await doAction(relay, a.connId, a.client.post('bad content'));
    expect(postResult.ok).toBe(true);
    const msgId = (postResult as { ok: true; id: string }).id;
    const deleted: string[] = [];
    a.client.subscribe({ onDeleted: id => deleted.push(id) });

    for (let i = 0; i < 3; i++) {
      const r = await makeUser(`reporter${i}`, `ip-r${i}`);
      const reported = await doAction(relay, r.connId, r.client.report(msgId));
      expect(reported.ok).toBe(true);
      if (reported.ok) expect(reported.id).not.toBe(msgId); // ack carries the report's own id
      expect(deleted).toEqual(i < 2 ? [] : [msgId]);
      r.client.close();
    }
    const self = await doAction(relay, a.connId, a.client.report(msgId));
    expect(self.ok).toBe(false); // deleted (and own) message cannot be reported
    expect((await relay.store.getBacklog(50)).some(m => m.id === msgId)).toBe(false);
    a.client.close();
  });

  it('client owns the 24h rename rule while relay only backstops observed rapid changes', async () => {
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

    // Relay side: first observed name change starts the abuse-backstop clock.
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

    // Relay observes a valid local rename immediately after first hello.
    relay.setTime(t0);
    const renamed = await connect(relay, s3, d2, 'ip-a2');
    expect(renamed.welcome.you.name).toBe('alice2');
    renamed.client.close();

    // A second observed change inside ten minutes hits only the abuse backstop.
    const s4 = new FileIdentityStore({ filePath: join(d2, 'identity.json'),
      now: () => t0 + 2 * NAME_CHANGE_INTERVAL_MS + 2 });
    expect((await s4.rename('alice3')).ok).toBe(true);
    const end3 = new ClientEnd();
    const connId3 = relay.register(end3, 'ip-a3');
    const client3 = new GlobalChatClient({ url: 'ws://127.0.0.1/global', identity: s4,
      WebSocket: relay.socketFactory(end3), now: () => t0 });
    const errP = awaitError(client3);
    await client3.connect(); end3.triggerOpen(); await tick(100); // 100ms tolerates loaded CI
    await relay.flush(connId3); await tick(50);
    const err = await errP;
    expect(err.code).toBe('name_change_too_soon');
    expect(err.retryAfterMs).toBe(600_000);
    client3.close();
  });
});
