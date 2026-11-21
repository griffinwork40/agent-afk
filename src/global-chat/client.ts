import type {
  ChatActionResult, ChatClient, ChatClientEvents, ChatIdentity, ChatPostResult,
  ChatRelayError, IdentityStore,
} from './client-types.js';
import {
  canonicalAdmin, canonicalHello, canonicalPost, canonicalReport,
  MAX_LINKS, MAX_TEXT_CHARS, PROTOCOL_VERSION,
  type AdminOp, type ClientFrame, type Msg, type RelayFrame,
} from './protocol.js';
import { deriveTag, randomMessageId, verifyMsg } from './crypto.js';
import { countLinks, sanitizeChatText } from './sanitize.js';
import { detectSecrets } from './secret-detect.js';
import { ChatTransport, type TransportOptions } from './client.transport.js';
export type { ChatSocket, ChatSocketConstructor, ChatTimers } from './client.transport.js';

export interface GlobalChatClientOptions extends TransportOptions {
  identity: IdentityStore;
  now?: () => number;
}
type UnsignedAction = Extract<ClientFrame, { id: string }> extends infer F
  ? F extends { id: string } ? Omit<F, 'sig'> : never : never;
interface Pending {
  resolve(result: ChatActionResult): void;
  timer: ReturnType<typeof setTimeout>;
}
const disconnected = (): ChatActionResult => ({ ok: false, code: 'not_connected', message: 'Chat is not connected' });

export class GlobalChatClient implements ChatClient {
  readonly #identity: IdentityStore;
  readonly #now: () => number;
  readonly #transport: ChatTransport;
  readonly #subscribers = new Set<Partial<ChatClientEvents>>();
  readonly #pending = new Map<string, Pending>();
  #you: ChatIdentity | null = null;
  #connectGeneration = 0;
  #signing: Promise<unknown> = Promise.resolve();

  constructor(options: GlobalChatClientOptions) {
    this.#identity = options.identity;
    this.#now = options.now ?? Date.now;
    this.#transport = new ChatTransport(options,
      status => this.#emit('onStatus', status),
      current => this.#hello(current),
      (frame, current) => this.#receive(frame, current),
      () => this.#failPending());
  }
  async connect(): Promise<void> {
    // Storage errors are intentionally generic: never let key material reach a caller.
    const generation = this.#connectGeneration;
    let identity: ChatIdentity | null;
    try { identity = await this.#identity.load(); }
    catch { throw new Error('Unable to load chat identity'); }
    if (generation !== this.#connectGeneration) return;
    if (!identity) throw new Error('Create a chat identity before connecting');
    this.#you = identity;
    this.#transport.connect();
  }
  close(): void { this.#connectGeneration++; this.#transport.close(); }
  subscribe(events: Partial<ChatClientEvents>): () => void {
    this.#subscribers.add(events);
    return () => { this.#subscribers.delete(events); };
  }
  async post(input: string): Promise<ChatPostResult> {
    const text = sanitizeChatText(input);
    if (!text) return { ok: false, code: 'bad_frame', message: 'Message is empty' };
    // UTF-16 length, matching JavaScript string.length on the relay (not code points).
    if (text.length > MAX_TEXT_CHARS) return { ok: false, code: 'too_long', message: 'Message exceeds 500 characters' };
    if (countLinks(text) > MAX_LINKS) return { ok: false, code: 'too_many_links', message: 'Message contains too many links' };
    const spans = detectSecrets(text);
    if (spans.length) return { ok: false, code: 'secret_detected', message: 'Message may contain a credential', spans };
    if (!this.#you) return disconnected() as ChatPostResult;
    const fields = { id: randomMessageId(), ts: this.#now(), name: this.#you.name, text };
    const result = await this.#action({ t: 'post', id: fields.id, ts: fields.ts, text }, canonicalPost(fields));
    return !result.ok && result.code === 'secret_detected' ? { ...result, code: 'secret_detected', spans: [] } : result as ChatPostResult;
  }
  async report(target: string): Promise<ChatActionResult> {
    if (!/^[0-9a-f]{32}$/.test(target)) return { ok: false, code: 'bad_frame', message: 'Invalid message identifier' };
    const fields = { id: randomMessageId(), ts: this.#now(), target };
    return this.#action({ t: 'report', ...fields }, canonicalReport(fields));
  }
  async admin(op: AdminOp, arg: string): Promise<ChatActionResult> {
    if (!['ban', 'unban', 'delete', 'mode'].includes(op) || sanitizeChatText(arg) !== arg || arg.length > 500) {
      return { ok: false, code: 'bad_frame', message: 'Invalid moderation action' };
    }
    const fields = { id: randomMessageId(), ts: this.#now(), op, arg };
    return this.#action({ t: 'admin', ...fields }, canonicalAdmin(fields));
  }
  async #hello(current: () => boolean): Promise<void> {
    if (!this.#you || !current()) return;
    const fields = { ts: this.#now(), pubkey: this.#you.pubkey, name: this.#you.name };
    let sig: string;
    try { sig = await this.#identity.sign(canonicalHello(fields)); }
    catch {
      if (current()) {
        this.close();
        this.#emit('onError', { code: 'bad_signature', message: 'Unable to sign chat handshake' });
      }
      return;
    }
    if (current()) this.#transport.send({ t: 'hello', v: PROTOCOL_VERSION, ...fields, sig });
  }
  async #action(frame: UnsignedAction, canonical: string): Promise<ChatActionResult> {
    if (!this.#transport.ready) return disconnected();
    const generation = this.#transport.generation;
    // Signing is asynchronous (WebCrypto) and completion order is not call
    // order, so concurrent actions are signed one after another: frames reach
    // the relay in the order the caller issued them (two quick posts never swap).
    const signed = this.#signing.then(() => this.#identity.sign(canonical));
    this.#signing = signed.catch(() => undefined);
    let sig: string;
    try { sig = await signed; }
    catch { return { ok: false, code: 'bad_signature', message: 'Unable to sign chat action' }; }
    if (!this.#transport.ready || generation !== this.#transport.generation) return disconnected();
    return new Promise(resolve => {
      const timer = this.#transport.timers.setTimeout(() => {
        this.#pending.delete(frame.id);
        resolve({ ok: false, id: frame.id, code: 'timeout', message: 'Chat action timed out' });
      }, 10_000);
      this.#pending.set(frame.id, { resolve, timer });
      if (!this.#transport.send({ ...frame, sig })) this.#settle(frame.id, disconnected());
    });
  }
  #settle(id: string, result: ChatActionResult): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    this.#transport.timers.clearTimeout(pending.timer);
    pending.resolve(result);
  }
  #failPending(): void {
    for (const id of this.#pending.keys()) this.#settle(id, disconnected());
  }
  async #clean(message: Msg): Promise<boolean> {
    return await verifyMsg(message) && sanitizeChatText(message.text) === message.text &&
      sanitizeChatText(message.name) === message.name;
  }
  async #receive(frame: RelayFrame, current: () => boolean): Promise<void> {
    if (frame.t === 'welcome') {
      if (frame.you.pubkey !== this.#you?.pubkey || frame.you.name !== this.#you.name) return;
      const backlog: Msg[] = [];
      for (const message of frame.backlog) if (await this.#clean(message)) backlog.push(message);
      const tag = await deriveTag(frame.you.pubkey);
      if (!current()) return;
      this.#transport.welcomed();
      this.#emit('onWelcome', { ...frame, backlog, you: { ...frame.you, tag } });
    } else if (frame.t === 'msg') {
      if (await this.#clean(frame.m) && current()) this.#emit('onMessage', frame.m);
    } else if (frame.t === 'error') {
      // Relay descriptions are untrusted: do not surface reflected text or key material.
      const error: ChatRelayError = { ...frame, message: 'Chat relay refused the request' };
      if (frame.id) this.#settle(frame.id, { ...error, ok: false });
      const terminal = this.#transport.terminal(error);
      if (terminal) this.close();
      this.#emit('onError', error);
    } else if (frame.t === 'ack') this.#settle(frame.id, { ok: true, id: frame.id });
    else if (frame.t === 'presence') this.#emit('onPresence', frame.online);
    else if (frame.t === 'deleted') this.#emit('onDeleted', frame.id);
    else if (frame.t === 'mode') this.#emit('onMode', frame.mode);
    else if (frame.t === 'pong') this.#transport.pong(frame.n);
  }
  #emit<K extends keyof ChatClientEvents>(event: K, arg: Parameters<ChatClientEvents[K]>[0]): void {
    for (const subscriber of this.#subscribers) {
      try { (subscriber[event] as ((value: typeof arg) => void) | undefined)?.(arg); }
      catch { /* A subscriber must not break protocol processing or expose peer text. */ }
    }
  }
}
