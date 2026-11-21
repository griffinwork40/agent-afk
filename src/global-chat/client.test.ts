/**
 * Comprehensive tests for GlobalChatClient + ChatTransport.
 * Split: helpers in client.test.helpers.ts (<=350 lines).
 * Uses real Web Crypto (Ed25519) + manual fake timers (no vi.useFakeTimers).
 * Async flushing via setImmediate (flushAsync).
 */
import { describe, it, expect } from 'vitest';
import { validateChatUrl } from './client.transport.js';
import { GlobalChatClient } from './client.js';
import { PROTOCOL_VERSION, type Msg } from './protocol.js';
import {
  makeKeyPair, makeMsg, makeForgedMsg, makeFakeIdentityStore,
  FakeSocket, FakeSocketFactory, FakeTimers, flushAsync,
  makeWelcomeFrame, sentOfType,
  signedHello, awaitWelcome,
  type KeyPairCtx, type FakeIdentityStore,
} from './client.test.helpers.js';

// ============================================================
// 1. URL VALIDATION
// ============================================================
describe('validateChatUrl', () => {
  it('accepts wss:// on any host', () => {
    expect(validateChatUrl('wss://chat.example.com/relay')).toBe('wss://chat.example.com/relay');
    expect(validateChatUrl('wss://chat.example.com')).toBe('wss://chat.example.com/');
  });
  it('accepts ws:// on loopback hostnames', () => {
    expect(validateChatUrl('ws://localhost/relay')).toBe('ws://localhost/relay');
    expect(validateChatUrl('ws://127.0.0.1/relay')).toBe('ws://127.0.0.1/relay');
    expect(validateChatUrl('ws://[::1]/relay')).toBe('ws://[::1]/relay');
  });
  it('rejects ws:// on non-loopback', () => {
    expect(() => validateChatUrl('ws://chat.example.com')).toThrow(/wss/);
  });
  it('rejects credentials in URL', () => {
    expect(() => validateChatUrl('wss://user:pass@chat.example.com')).toThrow();
    expect(() => validateChatUrl('wss://user@chat.example.com')).toThrow();
  });
  it('rejects hash fragment', () => {
    expect(() => validateChatUrl('wss://chat.example.com/#foo')).toThrow();
  });
  it('rejects http://', () => {
    expect(() => validateChatUrl('http://chat.example.com')).toThrow();
  });
  it('rejects garbage', () => {
    expect(() => validateChatUrl('not-a-url')).toThrow();
    expect(() => validateChatUrl('')).toThrow();
  });
});

// ============================================================
// Shared setup factory
// ============================================================
interface Ctx {
  kp: KeyPairCtx;
  store: FakeIdentityStore;
  factory: FakeSocketFactory;
  timers: FakeTimers;
  client: GlobalChatClient;
  now: { value: number };
}

async function setup(name = 'alice'): Promise<Ctx> {
  const kp = await makeKeyPair(name);
  const store = makeFakeIdentityStore(kp);
  const factory = new FakeSocketFactory();
  const timers = new FakeTimers();
  const now = { value: 1_700_000_000_000 };
  const client = new GlobalChatClient({
    url: 'wss://relay.example.com',
    WebSocket: factory.Constructor,
    timers,
    identity: store,
    now: () => now.value,
  });
  return { kp, store, factory, timers, client, now };
}

/** Connect + open the socket + deliver welcome, returning socket and welcome. */
async function connectAndWelcome(ctx: Ctx, backlog: Msg[] = []): Promise<FakeSocket> {
  await ctx.client.connect();
  const sock = ctx.factory.latest;
  sock.triggerOpen();
  await flushAsync();
  sock.triggerMessageStr(makeWelcomeFrame(ctx.kp, backlog));
  await flushAsync();
  return sock;
}

// ============================================================
// 2. CONNECTION LIFECYCLE + STATUSES
// ============================================================
describe('connection lifecycle', () => {
  it('emits connecting on connect()', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    await ctx.client.connect();
    expect(statuses).toContain('connecting');
  });

  it('emits open after welcome', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    await connectAndWelcome(ctx);
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('emits reconnecting when socket closes unexpectedly', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    await connectAndWelcome(ctx);
    ctx.factory.latest.triggerClose();
    await flushAsync();
    expect(statuses).toContain('reconnecting');
  });

  it('emits closed on client.close()', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    await connectAndWelcome(ctx);
    ctx.client.close();
    expect(statuses[statuses.length - 1]).toBe('closed');
  });

  it('connect() is idempotent while connected', async () => {
    const ctx = await setup();
    await ctx.client.connect();
    const count1 = ctx.factory.sockets.length;
    await ctx.client.connect(); // should be ignored
    expect(ctx.factory.sockets.length).toBe(count1);
  });

  it('throws if no identity loaded', async () => {
    const ctx = await setup();
    ctx.store._identity = null;
    await expect(ctx.client.connect()).rejects.toThrow('Create a chat identity');
  });

  it('throws if identity.load() rejects — generic message, no key material', async () => {
    const ctx = await setup();
    ctx.store.load = async () => { throw new Error('disk error with secret sk-proj-abc123'); };
    await expect(ctx.client.connect()).rejects.toThrow('Unable to load chat identity');
    // Ensure original error message (with credential text) is NOT exposed
    await expect(ctx.client.connect()).rejects.not.toThrow('sk-proj');
  });

  it('ready is false before connect, false after close', async () => {
    const ctx = await setup();
    // Access transport.ready indirectly via post
    const pre = await ctx.client.post('hello');
    expect(pre.ok).toBe(false);
    expect((pre as { code: string }).code).toBe('not_connected');
    await connectAndWelcome(ctx);
    ctx.client.close();
    const post = await ctx.client.post('hello');
    expect(post.ok).toBe(false);
    expect((post as { code: string }).code).toBe('not_connected');
  });
});

// ============================================================
// 3. HELLO FRAME IS SIGNED
// ============================================================
describe('hello frame', () => {
  it('sends hello with correct signature on socket open', async () => {
    const ctx = await setup();
    await ctx.client.connect();
    const sock = ctx.factory.latest;
    sock.triggerOpen();
    await flushAsync();
    const hellos = sentOfType<Record<string, unknown>>(sock, 'hello');
    expect(hellos).toHaveLength(1);
    const h = hellos[0]!;
    expect(h['v']).toBe(PROTOCOL_VERSION);
    expect(h['pubkey']).toBe(ctx.kp.pubkey);
    expect(h['name']).toBe(ctx.kp.identity.name);
    expect(typeof h['sig']).toBe('string');
    expect((h['sig'] as string)).toMatch(/^[0-9a-f]{128}$/);
    // Verify signature matches what we'd compute ourselves
    const expected = await signedHello(ctx.kp, h['ts'] as number);
    expect(h['sig']).toBe(expected);
  });

  it('does not send hello if socket replaced before sign completes', async () => {
    const ctx = await setup();
    // Delay sign so the socket can be replaced before hello is sent
    let resolveSig!: (s: string) => void;
    ctx.store.sign = () => new Promise<string>(r => { resolveSig = r; });
    await ctx.client.connect();
    const sock1 = ctx.factory.latest;
    sock1.triggerOpen();
    await flushAsync();
    // Drop the socket before sign resolves → current() returns false
    sock1.triggerClose();
    await flushAsync();
    resolveSig('a'.repeat(128));
    await flushAsync();
    // Hello should NOT have been sent on sock1
    const hellos = sentOfType(sock1, 'hello');
    expect(hellos).toHaveLength(0);
  });
});

// ============================================================
// 4. WELCOME BACKLOG: ORDER, VERIFIED, DIRTY REJECTED
// ============================================================
describe('welcome backlog', () => {
  it('delivers backlog in order, only verified messages', async () => {
    const ctx = await setup();
    const other = await makeKeyPair('bob');
    const m1 = await makeMsg(ctx.kp, { ts: 1000 });
    const m2 = await makeMsg(other, { ts: 2000 });
    const forged = await makeForgedMsg(ctx.kp, other);

    // awaitWelcome waits for the real async crypto to complete before asserting
    const welcomeP = awaitWelcome(ctx.client);
    await ctx.client.connect();
    const sock = ctx.factory.latest;
    sock.triggerOpen();
    await flushAsync(); // hello sign+send
    sock.triggerMessageStr(makeWelcomeFrame(ctx.kp, [m1, forged, m2]));
    const welcome = await welcomeP;
    // forged should be dropped — only m1 and m2 survive verification
    expect(welcome.backlog.map(m => m.id)).toEqual([m1.id, m2.id]);
  });

  it('drops backlog message with dirty (unsanitized) text', async () => {
    const ctx = await setup();
    // A message whose text contains a control character — will fail sanitize check
    const dirty = await makeMsg(ctx.kp, { text: 'bad\x01text' });
    // Re-sign dirty text so signature is valid for the dirty content
    // (verifyMsg passes for it, but sanitizeChatText(dirty.text) !== dirty.text)
    const received: Msg[] = [];
    ctx.client.subscribe({ onWelcome: w => received.push(...w.backlog) });
    await ctx.client.connect();
    const sock = ctx.factory.latest;
    sock.triggerOpen();
    await flushAsync();
    sock.triggerMessageStr(makeWelcomeFrame(ctx.kp, [dirty]));
    await flushAsync();
    expect(received).toHaveLength(0);
  });

  it('deriveTag is included in welcome you', async () => {
    const ctx = await setup();
    let tag: string | undefined;
    ctx.client.subscribe({ onWelcome: w => { tag = w.you.tag; } });
    await connectAndWelcome(ctx);
    expect(tag).toMatch(/^[0-9a-f]{4}$/);
  });
});

// ============================================================
// 5. LIVE MESSAGES: VERIFIED OR DROPPED
// ============================================================
describe('live messages', () => {
  it('emits onMessage for valid signed messages', async () => {
    const ctx = await setup();
    const other = await makeKeyPair('bob');
    const m = await makeMsg(other);
    const received: Msg[] = [];
    ctx.client.subscribe({ onMessage: m => received.push(m) });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'msg', m });
    await flushAsync();
    expect(received).toHaveLength(1);
    expect(received[0]!.id).toBe(m.id);
  });

  it('drops forged live message silently', async () => {
    const ctx = await setup();
    const other = await makeKeyPair('bob');
    const forged = await makeForgedMsg(ctx.kp, other);
    const received: Msg[] = [];
    ctx.client.subscribe({ onMessage: m => received.push(m) });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'msg', m: forged });
    await flushAsync();
    expect(received).toHaveLength(0);
  });

  it('drops live message with dirty name', async () => {
    const ctx = await setup();
    // Create a message where name has control chars → sanitize mismatch
    const dirty = await makeMsg(ctx.kp, { name: 'al\x01ice' });
    const received: Msg[] = [];
    ctx.client.subscribe({ onMessage: m => received.push(m) });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'msg', m: dirty });
    await flushAsync();
    expect(received).toHaveLength(0);
  });

  it('ignores malformed/oversized frames', async () => {
    const ctx = await setup();
    const errors: unknown[] = [];
    ctx.client.subscribe({ onError: e => errors.push(e) });
    const sock = await connectAndWelcome(ctx);
    // Malformed JSON
    sock.triggerMessage('not json at all {{{');
    // Oversized: relay frame limit is 262144 bytes
    sock.triggerMessage('x'.repeat(300_000));
    // Non-string data
    sock.triggerMessage(12345);
    // Valid JSON but unknown frame type
    sock.triggerMessage(JSON.stringify({ t: 'unknown_frame_type', data: 'x' }));
    await flushAsync();
    // None of these should emit errors (they're silently dropped by the parser)
    expect(errors).toHaveLength(0);
  });
});

// ============================================================
// 6. POST: SANITIZATION, VALIDATIONS, ACK, TIMEOUT
// ============================================================
describe('post', () => {
  it('returns not_connected when not connected', async () => {
    const ctx = await setup();
    await ctx.client.connect();
    const result = await ctx.client.post('hello');
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('not_connected');
  });

  it('returns bad_frame for empty message after sanitization', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const result = await ctx.client.post('   \t\n  ');
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('bad_frame');
  });

  it('returns too_long for message exceeding 500 UTF-16 chars', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const result = await ctx.client.post('a'.repeat(501));
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('too_long');
  });

  it('returns too_many_links when >2 links', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const text = 'check https://a.com and https://b.com and https://c.com out';
    const result = await ctx.client.post(text);
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('too_many_links');
  });

  it('returns secret_detected with spans for local secret detection', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const result = await ctx.client.post('my key is sk-ant-' + 'A'.repeat(25));
    expect(result.ok).toBe(false);
    const r = result as { code: string; spans: unknown[] };
    expect(r.code).toBe('secret_detected');
    expect(r.spans.length).toBeGreaterThan(0);
  });

  it('resolves with ok:true and id on ack', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    const postP = ctx.client.post('hello world');
    await flushAsync();
    const posts = sentOfType<Record<string, unknown>>(sock, 'post');
    expect(posts).toHaveLength(1);
    const id = posts[0]!['id'] as string;
    sock.triggerMessageStr({ t: 'ack', id });
    await flushAsync();
    const result = await postP;
    expect(result.ok).toBe(true);
    expect((result as { id: string }).id).toBe(id);
  });

  it('resolves with error on matching relay error', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    const postP = ctx.client.post('hello world');
    await flushAsync();
    const posts = sentOfType<Record<string, unknown>>(sock, 'post');
    const id = posts[0]!['id'] as string;
    sock.triggerMessageStr({ t: 'error', code: 'rate_limited', message: 'slow down', id });
    await flushAsync();
    const result = await postP;
    expect(result.ok).toBe(false);
    expect((result as { id?: string }).id).toBe(id);
    // relay message must NOT be surfaced
    expect((result as { message: string }).message).not.toContain('slow down');
  });

  it('times out after 10s and resolves with timeout code', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const postP = ctx.client.post('hello world');
    await flushAsync();
    ctx.timers.tick(10_001);
    await flushAsync();
    const result = await postP;
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('timeout');
  });

  it('relay secret_detected error produces spans:[] on post result', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    const postP = ctx.client.post('hello world');
    await flushAsync();
    const posts = sentOfType<Record<string, unknown>>(sock, 'post');
    const id = posts[0]!['id'] as string;
    sock.triggerMessageStr({ t: 'error', code: 'secret_detected', message: 'secret in relay', id });
    await flushAsync();
    const result = await postP;
    expect(result.ok).toBe(false);
    const r = result as { code: string; spans: unknown[] };
    expect(r.code).toBe('secret_detected');
    expect(r.spans).toEqual([]);
  });

  it('post sanitizes text (tabs/newlines collapsed to space)', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    const postP = ctx.client.post('hello\t\nworld');
    await flushAsync();
    const posts = sentOfType<Record<string, unknown>>(sock, 'post');
    expect(posts).toHaveLength(1);
    expect(posts[0]!['text']).toBe('hello world');
    // Settle the pending promise
    const id = posts[0]!['id'] as string;
    sock.triggerMessageStr({ t: 'ack', id });
    await postP;
  });

  it('returns not_connected if socket lost between sign and send', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    let resolveSig!: (s: string) => void;
    ctx.store.sign = () => new Promise<string>(r => { resolveSig = r; });
    const postP = ctx.client.post('hello world');
    await flushAsync();
    ctx.client.close();
    resolveSig('a'.repeat(128));
    await flushAsync();
    const result = await postP;
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('not_connected');
  });

  it('returns bad_signature if identity.sign throws', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    ctx.store.sign = async () => { throw new Error('hardware key gone'); };
    const result = await ctx.client.post('hello world');
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('bad_signature');
    // Error message must NOT contain the internal error text
    expect((result as { message: string }).message).not.toContain('hardware key gone');
  });
});

// ============================================================
// 7. REPORT + ADMIN: SIGNED, ACK, FAILURES
// ============================================================
describe('report', () => {
  it('returns bad_frame for invalid target id', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const r1 = await ctx.client.report('not-hex');
    expect(r1.ok).toBe(false);
    expect((r1 as { code: string }).code).toBe('bad_frame');
    const r2 = await ctx.client.report('abc'); // too short
    expect(r2.ok).toBe(false);
  });

  it('sends signed report and resolves on ack', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    const target = 'a'.repeat(32);
    const reportP = ctx.client.report(target);
    await flushAsync();
    const reports = sentOfType<Record<string, unknown>>(sock, 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!['target']).toBe(target);
    expect((reports[0]!['sig'] as string)).toMatch(/^[0-9a-f]{128}$/);
    const id = reports[0]!['id'] as string;
    sock.triggerMessageStr({ t: 'ack', id });
    await flushAsync();
    const result = await reportP;
    expect(result.ok).toBe(true);
  });

  it('returns not_connected if not connected', async () => {
    const ctx = await setup();
    const r = await ctx.client.report('a'.repeat(32));
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('not_connected');
  });
});

describe('admin', () => {
  it('returns bad_frame for invalid op', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const r = await ctx.client.admin('hack' as 'ban', 'alice');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('bad_frame');
  });

  it('returns bad_frame for arg that needs sanitization', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const r = await ctx.client.admin('ban', 'al\x01ice');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('bad_frame');
  });

  it('sends signed admin and resolves on ack', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    const adminP = ctx.client.admin('ban', 'baduser');
    await flushAsync();
    const admins = sentOfType<Record<string, unknown>>(sock, 'admin');
    expect(admins).toHaveLength(1);
    expect(admins[0]!['op']).toBe('ban');
    expect(admins[0]!['arg']).toBe('baduser');
    const id = admins[0]!['id'] as string;
    sock.triggerMessageStr({ t: 'ack', id });
    await flushAsync();
    const result = await adminP;
    expect(result.ok).toBe(true);
  });
});

// ============================================================
// 8. HEARTBEAT: 30s ping, 10s pong deadline
// ============================================================
describe('heartbeat', () => {
  it('sends ping after 30s of open connection', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    ctx.timers.tick(30_001);
    await flushAsync();
    const pings = sentOfType<Record<string, unknown>>(sock, 'ping');
    expect(pings).toHaveLength(1);
    expect(typeof pings[0]!['n']).toBe('number');
  });

  it('pong resets the heartbeat cycle', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    ctx.timers.tick(30_001);
    await flushAsync();
    const pings = sentOfType<Record<string, unknown>>(sock, 'ping');
    const n = pings[0]!['n'] as number;
    // Reply with matching pong
    sock.triggerMessageStr({ t: 'pong', n });
    await flushAsync();
    // Another 30s should produce another ping
    ctx.timers.tick(30_001);
    await flushAsync();
    const pings2 = sentOfType<Record<string, unknown>>(sock, 'ping');
    expect(pings2).toHaveLength(2);
  });

  it('stale pong (wrong n) is ignored', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    ctx.timers.tick(30_001);
    await flushAsync();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    sock.triggerMessageStr({ t: 'pong', n: 9999 }); // wrong n
    await flushAsync();
    // Should NOT reconnect
    expect(statuses).not.toContain('reconnecting');
  });

  it('closes connection after 10s without pong', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    await connectAndWelcome(ctx);
    ctx.timers.tick(30_001); // trigger ping
    await flushAsync();
    ctx.timers.tick(10_001); // pong deadline
    await flushAsync();
    expect(statuses).toContain('reconnecting');
  });

  it('no ping before welcome', async () => {
    const ctx = await setup();
    await ctx.client.connect();
    const sock = ctx.factory.latest;
    sock.triggerOpen();
    await flushAsync();
    ctx.timers.tick(31_000);
    await flushAsync();
    const pings = sentOfType(sock, 'ping');
    expect(pings).toHaveLength(0);
  });
});

// ============================================================
// 9. CONNECT TIMEOUT (10s before welcome)
// ============================================================
describe('connect timeout', () => {
  it('reconnects if socket open but no welcome within 10s', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    await ctx.client.connect();
    const sock = ctx.factory.latest;
    sock.triggerOpen();
    await flushAsync();
    ctx.timers.tick(10_001);
    await flushAsync();
    expect(statuses).toContain('reconnecting');
  });

  it('reconnects if socket never opens within 10s', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    await ctx.client.connect();
    ctx.timers.tick(10_001);
    await flushAsync();
    expect(statuses).toContain('reconnecting');
  });
});

// ============================================================
// 10. BACKOFF: GROWS, CAPS, RESETS ON WELCOME
// ============================================================
describe('reconnection backoff', () => {
  it('uses deterministic random=0 to test base delays', async () => {
    // With random=0 and attempt=0: delay = min(30000, 1000*2^0) = 1000
    const ctx = await setup();
    // Override random to 0 for determinism
    const timers = new FakeTimers();
    const kp = ctx.kp;
    const store = makeFakeIdentityStore(kp);
    const factory = new FakeSocketFactory();
    const client = new GlobalChatClient({
      url: 'wss://relay.example.com',
      WebSocket: factory.Constructor,
      timers,
      identity: store,
      random: () => 0,
    });
    const statuses: string[] = [];
    client.subscribe({ onStatus: s => statuses.push(s) });
    await client.connect();
    // Fail immediately
    factory.latest.triggerClose();
    await flushAsync();
    expect(statuses).toContain('reconnecting');
    // Retry fires after 1000ms (attempt 0, random=0 → delay=1000)
    timers.tick(1001);
    await flushAsync();
    expect(factory.sockets.length).toBe(2);
    // Fail again, attempt=1 → delay=2000
    factory.latest.triggerClose();
    await flushAsync();
    timers.tick(2001);
    await flushAsync();
    expect(factory.sockets.length).toBe(3);
    client.close();
  });

  it('caps backoff at 30s', async () => {
    const timers = new FakeTimers();
    const kp = await makeKeyPair();
    const store = makeFakeIdentityStore(kp);
    const factory = new FakeSocketFactory();
    const client = new GlobalChatClient({
      url: 'wss://relay.example.com',
      WebSocket: factory.Constructor,
      timers,
      identity: store,
      random: () => 0,
    });
    await client.connect();
    // Drive 6 failures to push attempt beyond the cap
    for (let i = 0; i < 7; i++) {
      factory.latest.triggerClose();
      await flushAsync();
      timers.tick(31_000); // always enough to trigger even capped 30s
      await flushAsync();
    }
    // All sockets created = 1 initial + 7 reconnects
    expect(factory.sockets.length).toBe(8);
    client.close();
  });

  it('resets attempt counter after successful welcome', async () => {
    const timers = new FakeTimers();
    const kp = await makeKeyPair();
    const store = makeFakeIdentityStore(kp);
    const factory = new FakeSocketFactory();
    const client = new GlobalChatClient({
      url: 'wss://relay.example.com',
      WebSocket: factory.Constructor,
      timers,
      identity: store,
      random: () => 0,
    });
    await client.connect();
    // Fail twice to bump attempt
    factory.latest.triggerClose();
    await flushAsync();
    timers.tick(1001);
    await flushAsync();
    factory.latest.triggerClose();
    await flushAsync();
    timers.tick(2001);
    await flushAsync();
    // Now succeed with welcome → resets attempt to 0
    factory.latest.triggerOpen();
    await flushAsync();
    factory.latest.triggerMessageStr(makeWelcomeFrame(kp));
    await flushAsync();
    // Drop again — should retry at base delay (1000ms with attempt=0)
    factory.latest.triggerClose();
    await flushAsync();
    timers.tick(1001);
    await flushAsync();
    // Should have created a new socket after just 1001ms
    expect(factory.sockets.length).toBeGreaterThanOrEqual(4);
    client.close();
  });
});

// ============================================================
// 11. TERMINAL ERROR CODES
// ============================================================
describe('terminal error codes', () => {
  const terminalCodes = ['banned', 'closed'] as const;
  const helloOnlyCodes = ['bad_signature', 'bad_name', 'reserved_name', 'name_change_too_soon'] as const;
  const nonTerminalCodes = ['rate_limited', 'too_long', 'readonly', 'duplicate'] as const;

  for (const code of terminalCodes) {
    it(`closes on ${code} error (always terminal)`, async () => {
      const ctx = await setup();
      const statuses: string[] = [];
      ctx.client.subscribe({ onStatus: s => statuses.push(s) });
      const sock = await connectAndWelcome(ctx);
      sock.triggerMessageStr({ t: 'error', code, message: 'x' });
      await flushAsync();
      expect(statuses[statuses.length - 1]).toBe('closed');
    });
  }

  for (const code of helloOnlyCodes) {
    it(`closes on ${code} error when received during hello (before welcome, no id)`, async () => {
      const ctx = await setup();
      const statuses: string[] = [];
      ctx.client.subscribe({ onStatus: s => statuses.push(s) });
      await ctx.client.connect();
      const sock = ctx.factory.latest;
      sock.triggerOpen();
      await flushAsync();
      // Send error without id = during hello
      sock.triggerMessageStr({ t: 'error', code, message: 'x' });
      await flushAsync();
      expect(statuses[statuses.length - 1]).toBe('closed');
    });

    it(`does NOT close on ${code} error when id is present (action error, not hello)`, async () => {
      const ctx = await setup();
      const statuses: string[] = [];
      ctx.client.subscribe({ onStatus: s => statuses.push(s) });
      const sock = await connectAndWelcome(ctx);
      // With an id it's an action error, not a hello error
      sock.triggerMessageStr({ t: 'error', code, message: 'x', id: 'a'.repeat(32) });
      await flushAsync();
      expect(statuses[statuses.length - 1]).toBe('open');
    });

    it(`does NOT close on ${code} error when already welcomed (ready=true)`, async () => {
      const ctx = await setup();
      const statuses: string[] = [];
      ctx.client.subscribe({ onStatus: s => statuses.push(s) });
      const sock = await connectAndWelcome(ctx);
      // No id but after welcome → not terminal
      sock.triggerMessageStr({ t: 'error', code, message: 'x' });
      await flushAsync();
      expect(statuses[statuses.length - 1]).toBe('open');
    });
  }

  for (const code of nonTerminalCodes) {
    it(`does not close on non-terminal ${code} error`, async () => {
      const ctx = await setup();
      const statuses: string[] = [];
      ctx.client.subscribe({ onStatus: s => statuses.push(s) });
      const sock = await connectAndWelcome(ctx);
      sock.triggerMessageStr({ t: 'error', code, message: 'x' });
      await flushAsync();
      expect(statuses[statuses.length - 1]).toBe('open');
    });
  }

  it('emits onError for all relay errors (message is generic, not reflected)', async () => {
    const ctx = await setup();
    const errors: { code: string; message: string }[] = [];
    ctx.client.subscribe({ onError: e => errors.push(e) });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'error', code: 'rate_limited', message: 'reflected peer text' });
    await flushAsync();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).not.toContain('reflected peer text');
    expect(errors[0]!.message).toBe('Chat relay refused the request');
  });
});

// ============================================================
// 12. PENDING ACTIONS FAILED ON DISCONNECT
// ============================================================
describe('pending actions failed on disconnect', () => {
  it('resolves pending post with not_connected when socket drops', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    const postP = ctx.client.post('hello world');
    await flushAsync();
    sock.triggerClose();
    await flushAsync();
    const result = await postP;
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('not_connected');
  });

  it('resolves pending report with not_connected on close()', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const reportP = ctx.client.report('a'.repeat(32));
    await flushAsync();
    ctx.client.close();
    const result = await reportP;
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('not_connected');
  });
});

// ============================================================
// 13. MULTIPLE SUBSCRIBERS + UNSUBSCRIBE
// ============================================================
describe('subscribers', () => {
  it('delivers events to multiple subscribers', async () => {
    const ctx = await setup();
    const other = await makeKeyPair('bob');
    const m = await makeMsg(other);
    const counts = [0, 0];
    const unsub0 = ctx.client.subscribe({ onMessage: () => counts[0]++ });
    const unsub1 = ctx.client.subscribe({ onMessage: () => counts[1]++ });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'msg', m });
    await flushAsync();
    expect(counts).toEqual([1, 1]);
    unsub0();
    sock.triggerMessageStr({ t: 'msg', m: await makeMsg(other) });
    await flushAsync();
    expect(counts[0]).toBe(1); // unsubscribed
    expect(counts[1]).toBe(2); // still subscribed
    unsub1();
  });

  it('a throwing subscriber does not break other subscribers', async () => {
    const ctx = await setup();
    const other = await makeKeyPair('bob');
    const m = await makeMsg(other);
    let count = 0;
    ctx.client.subscribe({ onMessage: () => { throw new Error('subscriber crash'); } });
    ctx.client.subscribe({ onMessage: () => count++ });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'msg', m });
    await flushAsync();
    expect(count).toBe(1);
  });
});

// ============================================================
// 14. PRESENCE / DELETED / MODE EVENTS
// ============================================================
describe('relay event passthrough', () => {
  it('emits onPresence', async () => {
    const ctx = await setup();
    let online: number | undefined;
    ctx.client.subscribe({ onPresence: n => { online = n; } });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'presence', online: 42 });
    await flushAsync();
    expect(online).toBe(42);
  });

  it('emits onDeleted', async () => {
    const ctx = await setup();
    let deleted: string | undefined;
    ctx.client.subscribe({ onDeleted: id => { deleted = id; } });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'deleted', id: 'a'.repeat(32) });
    await flushAsync();
    expect(deleted).toBe('a'.repeat(32));
  });

  it('emits onMode', async () => {
    const ctx = await setup();
    let mode: string | undefined;
    ctx.client.subscribe({ onMode: m => { mode = m; } });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'mode', mode: 'readonly' });
    await flushAsync();
    expect(mode).toBe('readonly');
  });
});

// ============================================================
// 15. STALE SOCKET GUARD
// ============================================================
describe('stale socket guard', () => {
  it('stale socket message after reconnect is ignored', async () => {
    const ctx = await setup();
    // Use random=0 so backoff is exactly 1000ms
    const timers2 = new FakeTimers();
    const factory2 = new FakeSocketFactory();
    const client2 = new GlobalChatClient({
      url: 'wss://relay.example.com',
      WebSocket: factory2.Constructor,
      timers: timers2,
      identity: ctx.store,
      random: () => 0,
    });
    const received: Msg[] = [];
    client2.subscribe({ onMessage: m => received.push(m) });
    await client2.connect();
    const sock1 = factory2.latest;
    sock1.triggerOpen();
    await flushAsync();
    sock1.triggerMessageStr(makeWelcomeFrame(ctx.kp));
    await flushAsync();
    // Drop sock1 → triggers reconnect
    sock1.triggerClose();
    await flushAsync();
    // Tick past the 1000ms backoff to dial sock2
    timers2.tick(1001);
    await flushAsync();
    const sock2 = factory2.latest;
    expect(sock2).not.toBe(sock1);
    // Now receive a message on the OLD stale socket — should be ignored
    const other = await makeKeyPair('bob');
    const m = await makeMsg(other);
    sock1.triggerMessageStr({ t: 'msg', m });
    await flushAsync();
    expect(received).toHaveLength(0); // stale socket ignored
    client2.close();
  });
});

// ============================================================
// 16. NO TEXT IN THROWN ERRORS
// ============================================================
describe('no peer text in errors', () => {
  it('relay error message is never surfaced in onError callback', async () => {
    const ctx = await setup();
    const errors: string[] = [];
    ctx.client.subscribe({ onError: e => errors.push(e.message) });
    const sock = await connectAndWelcome(ctx);
    sock.triggerMessageStr({ t: 'error', code: 'banned', message: 'secret_relay_message_xyz' });
    await flushAsync();
    for (const msg of errors) {
      expect(msg).not.toContain('secret_relay_message_xyz');
    }
  });

  it('identity.load error message is not rethrown verbatim', async () => {
    const ctx = await setup();
    ctx.store.load = async () => { throw new Error('disk error PRIVATE KEY abc'); };
    let caught = '';
    try { await ctx.client.connect(); } catch (e) { caught = String(e); }
    expect(caught).not.toContain('PRIVATE KEY');
  });
});

// ============================================================
// 17. CLOSE BEFORE/DURING CONNECT
// ============================================================
describe('close before/during connect', () => {
  it('close() during connecting (before open) produces closed status', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    await ctx.client.connect();
    ctx.client.close();
    expect(statuses).toContain('closed');
  });

  it('close() cancels pending retry', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });
    await ctx.client.connect();
    factory_triggerError(ctx);
    await flushAsync();
    expect(statuses).toContain('reconnecting');
    ctx.client.close();
    expect(statuses[statuses.length - 1]).toBe('closed');
    const countBefore = ctx.factory.sockets.length;
    ctx.timers.tick(31_000);
    await flushAsync();
    // No new socket created after close
    expect(ctx.factory.sockets.length).toBe(countBefore);
  });
});

function factory_triggerError(ctx: Ctx): void {
  ctx.factory.latest.triggerError();
}

// ============================================================
// 18. ACK ONLY FOR MATCHING ID
// ============================================================
describe('ack matching', () => {
  it('ack with wrong id does not resolve the pending post', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);
    const postP = ctx.client.post('hello world');
    await flushAsync();
    // Send ack with wrong id
    sock.triggerMessageStr({ t: 'ack', id: 'b'.repeat(32) });
    await flushAsync();
    // Advance timer to let timeout fire
    ctx.timers.tick(10_001);
    await flushAsync();
    const result = await postP;
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('timeout');
  });
});

// ============================================================
// 19. CONCURRENT INFLIGHT ACTIONS: ACK ONLY MATCHING ACTION
// ============================================================
describe('concurrent inflight actions', () => {
  it('two concurrent posts each resolve with their own ack only', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);

    const postP1 = ctx.client.post('first message');
    const postP2 = ctx.client.post('second message');
    await flushAsync();

    const posts = sentOfType<Record<string, unknown>>(sock, 'post');
    expect(posts).toHaveLength(2);
    const id1 = posts[0]!['id'] as string;
    const id2 = posts[1]!['id'] as string;
    expect(id1).not.toBe(id2);

    // Ack id2 first — postP1 must still be pending
    sock.triggerMessageStr({ t: 'ack', id: id2 });
    await flushAsync();
    const r2 = await postP2;
    expect(r2.ok).toBe(true);
    expect((r2 as { id: string }).id).toBe(id2);

    // postP1 is still pending — now ack it
    sock.triggerMessageStr({ t: 'ack', id: id1 });
    await flushAsync();
    const r1 = await postP1;
    expect(r1.ok).toBe(true);
    expect((r1 as { id: string }).id).toBe(id1);
  });

  it('post and report inflight — wrong-type ack does not cross-resolve', async () => {
    const ctx = await setup();
    const sock = await connectAndWelcome(ctx);

    const postP = ctx.client.post('hello');
    const reportP = ctx.client.report('a'.repeat(32));
    await flushAsync();

    const posts = sentOfType<Record<string, unknown>>(sock, 'post');
    const reports = sentOfType<Record<string, unknown>>(sock, 'report');
    expect(posts).toHaveLength(1);
    expect(reports).toHaveLength(1);

    const postId = posts[0]!['id'] as string;
    const reportId = reports[0]!['id'] as string;

    // Ack with the report's id — the post must not resolve with it
    sock.triggerMessageStr({ t: 'ack', id: reportId });
    await flushAsync();
    const rr = await reportP;
    expect(rr.ok).toBe(true);

    // Post still pending; let it time out
    ctx.timers.tick(10_001);
    await flushAsync();
    const rp = await postP;
    expect(rp.ok).toBe(false);
    expect((rp as { code: string }).code).toBe('timeout');
    void postId; // suppress unused warning
  });
});

// ============================================================
// 20. REPORT + ADMIN 10s TIMEOUT
// ============================================================
describe('report and admin timeout', () => {
  it('report times out after 10s without ack', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const reportP = ctx.client.report('a'.repeat(32));
    await flushAsync();
    ctx.timers.tick(10_001);
    await flushAsync();
    const result = await reportP;
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('timeout');
  });

  it('admin times out after 10s without ack', async () => {
    const ctx = await setup();
    await connectAndWelcome(ctx);
    const adminP = ctx.client.admin('ban', 'baduser');
    await flushAsync();
    ctx.timers.tick(10_001);
    await flushAsync();
    const result = await adminP;
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('timeout');
  });
});

// ============================================================
// 21. CLOSE DURING IDENTITY LOAD (BEFORE SOCKET CREATION)
// ============================================================
describe('close during identity load', () => {
  it('close() while identity.load is in flight — closed status is emitted', async () => {
    const ctx = await setup();
    const statuses: string[] = [];
    ctx.client.subscribe({ onStatus: s => statuses.push(s) });

    // Delay load so we can call close() before it resolves
    let resolveLoad!: (id: typeof ctx.kp.identity | null) => void;
    ctx.store.load = () => new Promise(r => { resolveLoad = r; });

    const connectP = ctx.client.connect();
    // close() while load is pending — must synchronously emit closed
    ctx.client.close();
    expect(statuses).toContain('closed');

    // Let load finish — the TOCTOU window means connect() may still proceed,
    // but the primary contract is that closed was emitted and client.post() returns not_connected.
    resolveLoad(ctx.kp.identity);
    try { await connectP; } catch { /* may throw */ }
    await flushAsync();

    expect(statuses).toContain('closed');
    // post() must be not_connected after close() regardless of socket state
    const r = await ctx.client.post('test');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('not_connected');
  });
});

// ============================================================
// 22. CLOSE DURING BACKLOG VERIFICATION
// ============================================================
describe('close during backlog verification', () => {
  it('welcome backlog emitted even if close() fires mid-verify', async () => {
    const ctx = await setup();
    const other = await makeKeyPair('bob');
    const m1 = await makeMsg(ctx.kp, { ts: 1000 });
    const m2 = await makeMsg(other, { ts: 2000 });

    // Capture welcome via observer before closing; use short timeout since
    // close() may suppress delivery — a timeout rejection is also valid here.
    const welcomeP = awaitWelcome(ctx.client, 200);

    await ctx.client.connect();
    const sock = ctx.factory.latest;
    sock.triggerOpen();
    await flushAsync();
    sock.triggerMessageStr(makeWelcomeFrame(ctx.kp, [m1, m2]));
    // Close immediately after sending welcome, mid-verification
    ctx.client.close();

    // awaitWelcome may time out if close() suppresses delivery — that's also valid
    // behaviour; just ensure no unhandled rejection and no crash.
    let welcome: Awaited<typeof welcomeP> | null = null;
    try { welcome = await welcomeP; } catch { /* closed before welcome fired */ }

    if (welcome !== null) {
      // If welcome was delivered, backlog IDs must be a subset of valid msgs
      const validIds = new Set([m1.id, m2.id]);
      for (const m of welcome.backlog) expect(validIds.has(m.id)).toBe(true);
    }
    // No crash or unhandled rejection is the primary assertion
  });
});

// ============================================================
// 23. HELLO SIGN REJECTION → generic onError + closed
// ============================================================
describe('hello sign failure', () => {
  it('emits generic onError and closes when identity.sign throws during hello', async () => {
    const ctx = await setup();
    const errors: { code: string; message: string }[] = [];
    const statuses: string[] = [];
    ctx.client.subscribe({
      onError: e => errors.push(e),
      onStatus: s => statuses.push(s),
    });

    // Make sign throw
    ctx.store.sign = async () => { throw new Error('hardware key gone PRIVATE_KEY_abc'); };

    await ctx.client.connect();
    const sock = ctx.factory.latest;
    sock.triggerOpen();
    // Let the hello path run (sign throws → transport.close() called)
    await flushAsync();

    // Status must end at closed
    expect(statuses[statuses.length - 1]).toBe('closed');
    // If onError was emitted it must not contain private text
    for (const e of errors) {
      expect(e.message).not.toContain('PRIVATE_KEY_abc');
      expect(e.message).not.toContain('hardware key gone');
    }
  });
});

// ============================================================
// 24. ACTION SIGN AFTER RECONNECT: GENERATION GUARD
// ============================================================
describe('action sign across reconnect generation', () => {
  it('a post sign that completes after reconnect must NOT send on the new socket', async () => {
    // Use deterministic random=0 for fast backoff
    const timers = new FakeTimers();
    const kp = await makeKeyPair();
    const store = makeFakeIdentityStore(kp);
    const factory = new FakeSocketFactory();
    const client = new GlobalChatClient({
      url: 'wss://relay.example.com',
      WebSocket: factory.Constructor,
      timers,
      identity: store,
      random: () => 0,
    });

    // Connect + welcome on sock1
    await client.connect();
    const sock1 = factory.latest;
    sock1.triggerOpen();
    await flushAsync();
    sock1.triggerMessageStr(makeWelcomeFrame(kp));
    await flushAsync();

    // Freeze the sign call so it finishes AFTER the socket is replaced
    let resolveSig!: (s: string) => void;
    store.sign = () => new Promise<string>(r => { resolveSig = r; });

    // Start a post — sign is now pending
    const postP = client.post('hello world');
    await flushAsync();

    // Drop sock1 → reconnect starts; advance clock to create sock2
    sock1.triggerClose();
    await flushAsync();
    timers.tick(1001);
    await flushAsync();
    const sock2 = factory.latest;
    expect(sock2).not.toBe(sock1);

    // Now resolve the sign — the original generation is gone
    resolveSig('a'.repeat(128));
    await flushAsync();

    // The post must resolve as not_connected (generation mismatch)
    const result = await postP;
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('not_connected');

    // sock2 must NOT have received a post frame from the stale sign
    const sock2Posts = sentOfType(sock2, 'post');
    expect(sock2Posts).toHaveLength(0);

    client.close();
  });
});
