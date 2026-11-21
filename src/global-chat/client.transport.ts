import type { ChatConnectionStatus, ChatRelayError } from './client-types.js';
import { MAX_RELAY_FRAME_BYTES, type RelayFrame } from './protocol.js';

// Bound both CPU work and retained decoded data while signature verification waits.
export const MAX_PENDING_RELAY_FRAMES = 32;
export const MAX_PENDING_RELAY_BYTES = 1024 * 1024;
import { parseRelayFrame } from './protocol.parse.js';

export interface ChatSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
export interface ChatSocketConstructor { new(url: string): ChatSocket }
export interface ChatTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface TransportOptions {
  url: string;
  WebSocket?: ChatSocketConstructor;
  timers?: ChatTimers;
  random?: () => number;
}
export function validateChatUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.username || url.password || url.hash) throw new Error();
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
    return url.href;
  } catch { throw new Error('Chat relay URL must use wss, or ws on loopback, without credentials'); }
}

/** Owns socket generations: stale callbacks and asynchronous work cannot revive a closed socket. */
export class ChatTransport {
  readonly timers: ChatTimers;
  readonly #url: string;
  readonly #Socket: ChatSocketConstructor;
  readonly #random: () => number;
  readonly #status: (status: ChatConnectionStatus) => void;
  readonly #open: (current: () => boolean) => Promise<void>;
  readonly #frame: (frame: RelayFrame, current: () => boolean) => Promise<void>;
  readonly #disconnected: () => void;
  #socket: ChatSocket | undefined;
  #generation = 0;
  #stopped = true;
  #attempt = 0;
  #ready = false;
  #ping = 0;
  #awaitingPong: number | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #incoming: Promise<void> = Promise.resolve();

  constructor(options: TransportOptions, status: (s: ChatConnectionStatus) => void,
    open: (current: () => boolean) => Promise<void>,
    frame: (f: RelayFrame, current: () => boolean) => Promise<void>, disconnected: () => void) {
    this.#url = validateChatUrl(options.url);
    this.#Socket = options.WebSocket ?? globalThis.WebSocket;
    if (!this.#Socket) throw new Error('Chat requires WebSocket support');
    this.timers = options.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout };
    this.#random = options.random ?? Math.random;
    this.#status = status;
    this.#open = open;
    this.#frame = frame;
    this.#disconnected = disconnected;
  }
  get ready(): boolean { return this.#ready && !this.#stopped; }
  get generation(): number { return this.#generation; }
  connect(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attempt = 0;
    this.#status('connecting');
    this.#dial();
  }
  send(frame: object, handedToSocket?: () => void): boolean {
    if (!this.#socket || this.#stopped) return false;
    try {
      const data = JSON.stringify(frame);
      handedToSocket?.();
      this.#socket.send(data);
      return true;
    }
    catch { this.#lost(); return false; }
  }
  welcomed(): void {
    this.#ready = true;
    this.#attempt = 0;
    this.#clear('deadline');
    this.#status('open');
    this.#schedulePing();
  }
  pong(n: number): void {
    if (n !== this.#awaitingPong) return;
    this.#awaitingPong = undefined;
    this.#clear('deadline');
    this.#schedulePing();
  }
  terminal(error: ChatRelayError): boolean {
    return ['banned', 'closed'].includes(error.code) || (!this.#ready && !error.id &&
      ['bad_signature', 'bad_name', 'reserved_name', 'name_change_too_soon'].includes(error.code));
  }
  close(): void {
    this.#stopped = true;
    this.#clear('retry');
    this.#drop();
    this.#status('closed');
  }
  #dial(): void {
    if (this.#stopped) return;
    let socket: ChatSocket;
    try { socket = new this.#Socket(this.#url); }
    catch { this.#lost(); return; }
    this.#socket = socket;
    const current = (): boolean => this.#socket === socket && !this.#stopped;
    this.#incoming = Promise.resolve();
    let pendingCount = 0;
    let pendingBytes = 0;
    this.#deadline = this.timers.setTimeout(() => { if (current()) this.#lost(); }, 10_000);
    socket.addEventListener('open', () => {
      if (current()) void this.#open(current).catch(() => { if (current()) this.close(); });
    });
    socket.addEventListener('message', event => {
      if (!current() || typeof event.data !== 'string') return;
      if (event.data.length > MAX_RELAY_FRAME_BYTES) { this.#lost(); return; }
      const bytes = new TextEncoder().encode(event.data).length;
      if (bytes > MAX_RELAY_FRAME_BYTES || pendingCount >= MAX_PENDING_RELAY_FRAMES ||
        pendingBytes + bytes > MAX_PENDING_RELAY_BYTES) { this.#lost(); return; }
      const parsed = parseRelayFrame(event.data);
      if (!parsed.ok) return;
      pendingCount++;
      pendingBytes += bytes;
      this.#incoming = this.#incoming.then(async () => {
        if (current()) await this.#frame(parsed.frame, current);
      }).catch(() => { /* Invalid peer data must never escape the event loop. */ })
        .finally(() => { pendingCount--; pendingBytes -= bytes; });
    });
    for (const event of ['close', 'error'] as const) {
      socket.addEventListener(event, () => { if (current()) this.#lost(); });
    }
  }
  #schedulePing(): void {
    this.#clear('heartbeat');
    this.#heartbeat = this.timers.setTimeout(() => {
      if (!this.ready) return;
      const n = ++this.#ping;
      this.#awaitingPong = n;
      if (!this.send({ t: 'ping', n })) return;
      this.#deadline = this.timers.setTimeout(() => this.#lost(), 10_000);
    }, 30_000);
  }
  #lost(): void {
    this.#drop();
    if (this.#stopped || this.#retry !== undefined) return;
    this.#status('reconnecting');
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt++, 5));
    const delay = Math.min(30_000, base * (1 + this.#random() * 0.2));
    this.#retry = this.timers.setTimeout(() => {
      this.#retry = undefined;
      this.#dial();
    }, delay);
  }
  #drop(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation++;
    this.#ready = false;
    this.#awaitingPong = undefined;
    this.#clear('deadline');
    this.#clear('heartbeat');
    this.#disconnected();
    try { socket?.close(); } catch { /* Best effort, never disclose peer data. */ }
  }
  #clear(kind: 'deadline' | 'heartbeat' | 'retry'): void {
    const timer = kind === 'deadline' ? this.#deadline : kind === 'heartbeat' ? this.#heartbeat : this.#retry;
    if (timer !== undefined) this.timers.clearTimeout(timer);
    if (kind === 'deadline') this.#deadline = undefined;
    else if (kind === 'heartbeat') this.#heartbeat = undefined;
    else this.#retry = undefined;
  }
}
