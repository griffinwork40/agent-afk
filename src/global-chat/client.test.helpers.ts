/**
 * Shared test helpers for client.test.ts
 * Keep <=350 lines. Real crypto (generateKeyPair / sign / verifyMsg) is used throughout.
 */
import { generateKeyPair, importPrivateKey, sign, randomMessageId } from './crypto.js';
import {
  canonicalHello, canonicalPost, canonicalReport, canonicalAdmin,
  type Msg, type RelayFrame,
} from './protocol.js';
import type { ChatSocket, ChatSocketConstructor, ChatTimers } from './client.transport.js';
import type { ChatIdentity, IdentityStore } from './client-types.js';

// ---------------------------------------------------------------------------
// Real key-pair helpers (async, cached per test file load)
// ---------------------------------------------------------------------------
export interface KeyPairCtx {
  pubkey: string;
  privateKeyPkcs8: string;
  signMsg(canonical: string): Promise<string>;
  identity: ChatIdentity;
}

export async function makeKeyPair(name = 'alice'): Promise<KeyPairCtx> {
  const kp = await generateKeyPair();
  const sk = await importPrivateKey(kp.privateKeyPkcs8);
  const signMsg = (canonical: string) => sign(canonical, sk);
  return { ...kp, signMsg, identity: { pubkey: kp.pubkey, name, tag: 'aaaa' } };
}

/** Build a valid signed Msg using real Ed25519. */
export async function makeMsg(ctx: KeyPairCtx, overrides: Partial<Msg> = {}): Promise<Msg> {
  const base: Omit<Msg, 'sig'> = {
    id: randomMessageId(), ts: Date.now(),
    pubkey: ctx.pubkey, name: ctx.identity.name, text: 'Hello world',
    ...overrides,
  };
  const sig = await ctx.signMsg(canonicalPost(base as Msg));
  return { ...base, sig } as Msg;
}

/** Build a valid signed Msg with a forged (wrong) signature. */
export async function makeForgedMsg(ctx: KeyPairCtx, otherCtx: KeyPairCtx): Promise<Msg> {
  const base: Omit<Msg, 'sig'> = {
    id: randomMessageId(), ts: Date.now(),
    pubkey: ctx.pubkey, name: ctx.identity.name, text: 'Forged',
  };
  // Sign with the OTHER private key → verification will fail
  const sig = await otherCtx.signMsg(canonicalPost(base as Msg));
  return { ...base, sig } as Msg;
}

// ---------------------------------------------------------------------------
// Fake IdentityStore
// ---------------------------------------------------------------------------
export interface FakeIdentityStore extends IdentityStore {
  _identity: ChatIdentity | null;
  _signFn: (canonical: string) => Promise<string>;
}

export function makeFakeIdentityStore(ctx: KeyPairCtx): FakeIdentityStore {
  const store: FakeIdentityStore = {
    _identity: ctx.identity,
    _signFn: ctx.signMsg,
    async load() { return store._identity; },
    async create() { return { ok: false, code: 'already_exists' } as const; },
    async rename() { return { ok: false, code: 'bad_name' } as const; },
    async isNoticeAccepted() { return true; },
    async acceptNotice() {},
    async disable() {},
    async sign(canonical: string) { return store._signFn(canonical); },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------
export type ListenerMap = {
  open: Array<() => void>;
  close: Array<() => void>;
  error: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
};

export class FakeSocket implements ChatSocket {
  sent: string[] = [];
  closed = false;
  listeners: ListenerMap = { open: [], close: [], error: [], message: [] };

  send(data: string): void {
    if (this.closed) throw new Error('Socket closed');
    this.sent.push(data);
  }
  close(): void { this.closed = true; }

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: unknown, listener: unknown): void {
    (this.listeners[type as keyof ListenerMap] as unknown[]).push(listener);
  }

  // Helpers to trigger events
  triggerOpen(): void { this.listeners.open.forEach(fn => fn()); }
  triggerClose(): void { this.listeners.close.forEach(fn => fn()); }
  triggerError(): void { this.listeners.error.forEach(fn => fn()); }
  triggerMessage(data: unknown): void {
    this.listeners.message.forEach(fn => fn({ data }));
  }
  triggerMessageStr(frame: RelayFrame): void {
    this.triggerMessage(JSON.stringify(frame));
  }
}

// ---------------------------------------------------------------------------
// Fake socket factory (tracks all created sockets)
// ---------------------------------------------------------------------------
export class FakeSocketFactory {
  sockets: FakeSocket[] = [];

  get Constructor(): ChatSocketConstructor {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return class extends FakeSocket {
      constructor(_url: string) {
        super();
        self.sockets.push(this as unknown as FakeSocket);
      }
    } as unknown as ChatSocketConstructor;
  }

  get latest(): FakeSocket {
    if (!this.sockets.length) throw new Error('No sockets created yet');
    return this.sockets[this.sockets.length - 1]!;
  }
}

// ---------------------------------------------------------------------------
// Deterministic fake timers (manual tick, no vi.useFakeTimers needed)
// ---------------------------------------------------------------------------
export type TimerEntry = { id: number; at: number; fn: () => void; cancelled: boolean };

export class FakeTimers implements ChatTimers {
  private entries: TimerEntry[] = [];
  private nextId = 1;
  now = 0;

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const entry: TimerEntry = { id: this.nextId++, at: this.now + ms, fn: callback, cancelled: false };
    this.entries.push(entry);
    return entry.id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    const id = timer as unknown as number;
    const entry = this.entries.find(e => e.id === id);
    if (entry) entry.cancelled = true;
  }

  /** Advance clock by ms, firing all timers that fall in the window. */
  tick(ms: number): void {
    this.now += ms;
    // Sort by fire-time, fire in order (may queue more)
    let safety = 0;
    while (safety++ < 10_000) {
      const due = this.entries
        .filter(e => !e.cancelled && e.at <= this.now)
        .sort((a, b) => a.at - b.at);
      if (!due.length) break;
      const entry = due[0]!;
      entry.cancelled = true; // prevent re-fire
      entry.fn();
    }
  }

  /** Count live (pending, non-cancelled) timers. */
  pendingCount(): number {
    return this.entries.filter(e => !e.cancelled).length;
  }
}

// ---------------------------------------------------------------------------
// Flush microtasks — bounded real-timer approach, tolerates native crypto.
// Each round is a real 1ms setTimeout so the crypto SubtleCrypto queue drains
// between rounds; default 10 rounds is sufficient for sign+verify chains.
// ---------------------------------------------------------------------------
export async function flushAsync(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
}

// ---------------------------------------------------------------------------
// Observable-based async helpers — await specific client events explicitly.
// These are more robust than counting flushAsync rounds for crypto-heavy paths.
// ---------------------------------------------------------------------------

/** Returns a Promise that resolves with the first onWelcome event payload. */
export function awaitWelcome(
  client: { subscribe: (e: { onWelcome?: (w: WelcomePayload) => void }) => () => void },
  timeoutMs = 2000,
): Promise<WelcomePayload> {
  return new Promise<WelcomePayload>((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error('awaitWelcome timed out')); }, timeoutMs);
    const unsub = client.subscribe({
      onWelcome: w => { clearTimeout(timer); unsub(); resolve(w); },
    });
  });
}

/** Returns a Promise that resolves with the first onMessage event payload. */
export function awaitMessage(
  client: { subscribe: (e: { onMessage?: (m: MsgPayload) => void }) => () => void },
  timeoutMs = 2000,
): Promise<MsgPayload> {
  return new Promise<MsgPayload>((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error('awaitMessage timed out')); }, timeoutMs);
    const unsub = client.subscribe({
      onMessage: m => { clearTimeout(timer); unsub(); resolve(m); },
    });
  });
}

/** Returns a Promise that resolves after n onMessage events (accumulates all). */
export function awaitMessages(
  client: { subscribe: (e: { onMessage?: (m: MsgPayload) => void }) => () => void },
  n: number,
  timeoutMs = 2000,
): Promise<MsgPayload[]> {
  return new Promise<MsgPayload[]>((resolve, reject) => {
    const collected: MsgPayload[] = [];
    const timer = setTimeout(() => { unsub(); reject(new Error(`awaitMessages(${n}) timed out, got ${collected.length}`)); }, timeoutMs);
    const unsub = client.subscribe({
      onMessage: m => {
        collected.push(m);
        if (collected.length >= n) { clearTimeout(timer); unsub(); resolve(collected); }
      },
    });
  });
}

/** Returns a Promise that resolves with the first onStatus matching predicate. */
export function awaitStatus(
  client: { subscribe: (e: { onStatus?: (s: string) => void }) => () => void },
  predicate: (s: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error('awaitStatus timed out')); }, timeoutMs);
    const unsub = client.subscribe({
      onStatus: s => { if (predicate(s)) { clearTimeout(timer); unsub(); resolve(s); } },
    });
  });
}

/** Payload types used by the observer helpers above. */
export type WelcomePayload = {
  backlog: import('./protocol.js').Msg[];
  you: { pubkey: string; name: string; tag: string };
  online: number;
  mode: string;
};
export type MsgPayload = import('./protocol.js').Msg;

// ---------------------------------------------------------------------------
// Build a valid WelcomeFrame
// ---------------------------------------------------------------------------
export function makeWelcomeFrame(
  ctx: KeyPairCtx,
  backlog: Msg[] = [],
  overrides: Partial<RelayFrame & { t: 'welcome' }> = {},
): RelayFrame {
  return {
    t: 'welcome',
    online: 1,
    mode: 'open',
    backlog,
    you: { pubkey: ctx.pubkey, name: ctx.identity.name },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Canonical sign helpers for test assertions
// ---------------------------------------------------------------------------
export async function signedHello(ctx: KeyPairCtx, ts: number): Promise<string> {
  return ctx.signMsg(canonicalHello({ ts, pubkey: ctx.pubkey, name: ctx.identity.name }));
}
export async function signedPost(ctx: KeyPairCtx, fields: { id: string; ts: number; name: string; text: string }): Promise<string> {
  return ctx.signMsg(canonicalPost(fields));
}
export async function signedReport(ctx: KeyPairCtx, fields: { id: string; ts: number; target: string }): Promise<string> {
  return ctx.signMsg(canonicalReport(fields));
}
export async function signedAdmin(ctx: KeyPairCtx, fields: { id: string; ts: number; op: string; arg: string }): Promise<string> {
  return ctx.signMsg(canonicalAdmin(fields as Parameters<typeof canonicalAdmin>[0]));
}

// ---------------------------------------------------------------------------
// Helpers to parse sent frames from FakeSocket
// ---------------------------------------------------------------------------
export function parseSent(socket: FakeSocket): unknown[] {
  return socket.sent.map(s => JSON.parse(s));
}
export function lastSent(socket: FakeSocket): Record<string, unknown> {
  const frames = parseSent(socket);
  if (!frames.length) throw new Error('No frames sent');
  return frames[frames.length - 1] as Record<string, unknown>;
}
export function sentOfType<T extends Record<string, unknown>>(socket: FakeSocket, t: string): T[] {
  return parseSent(socket).filter((f): f is T => (f as Record<string, unknown>)['t'] === t);
}
