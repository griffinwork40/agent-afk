/** Fakes shared by the global chat view and slash command tests. */
import { EventEmitter } from 'node:events';
import type {
  ChatClient, ChatClientEvents, ChatIdentity, ChatPostResult, IdentityResult, IdentityStore, MuteStore, MutedIdentity,
} from '../../../global-chat/client-types.js';
import type { ChatClock } from './global-chat-view.js';
import type { ChatTeardownGuards } from './global-chat-terminal.js';

export const ME: ChatIdentity = { pubkey: 'c'.repeat(64), tag: 'abcd', name: 'me' };

export class FakeClock implements ChatClock {
  tasks: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  schedule(fn: () => void, ms: number): () => void {
    const t = { fn, ms, live: true };
    this.tasks.push(t);
    return () => { t.live = false; };
  }
  flush(): void {
    const due = this.tasks.filter((t) => t.live);
    this.tasks = [];
    for (const t of due) { t.live = false; t.fn(); }
  }
  pending(): number { return this.tasks.filter((t) => t.live).length; }
}

export class FakeStdin extends EventEmitter {
  raw: boolean[] = [];
  setRawMode(mode: boolean): void { this.raw.push(mode); }
  type(s: string): void { this.emit('data', Buffer.from(s, 'utf8')); }
}
export class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  writes: string[] = [];
  constructor(private readonly log: string[]) { super(); }
  write(s: string): boolean { this.writes.push(s); this.log.push(`write:${s.includes('\x1b[?1049l') ? 'LEAVE' : s.includes('\x1b[?1049h') ? 'ENTER' : 'paint'}`); return true; }
  text(): string { return this.writes.join(''); }
}

export class FakeClient implements ChatClient {
  subs: Array<Partial<ChatClientEvents>> = [];
  posts: string[] = [];
  reports: string[] = [];
  admins: Array<[string, string]> = [];
  closed = 0;
  connected = 0;
  nextPost: Promise<ChatPostResult> | ChatPostResult = { ok: true, id: 'x' };
  async connect(): Promise<void> { this.connected++; }
  async post(text: string): Promise<ChatPostResult> { this.posts.push(text); return this.nextPost; }
  async report(id: string) { this.reports.push(id); return { ok: true as const, id }; }
  async admin(op: 'ban' | 'unban' | 'delete' | 'mode', arg: string) { this.admins.push([op, arg]); return { ok: true as const, id: 'a' }; }
  close(): void { this.closed++; }
  subscribe(events: Partial<ChatClientEvents>): () => void {
    this.subs.push(events);
    return () => { this.subs = this.subs.filter((s) => s !== events); };
  }
  emit<K extends keyof ChatClientEvents>(k: K, ...args: Parameters<ChatClientEvents[K]>): void {
    for (const s of this.subs) (s[k] as ((...a: unknown[]) => void) | undefined)?.(...args);
  }
}

export class FakeIdentity implements IdentityStore {
  identity: ChatIdentity | null = ME;
  accepted = true;
  renameResult: IdentityResult | null = null;
  calls: string[] = [];
  async load() { return this.identity; }
  async create(name: string): Promise<IdentityResult> {
    this.calls.push(`create:${name}`);
    if (name === 'admin') return { ok: false, code: 'reserved_name' };
    this.identity = { ...ME, name };
    return { ok: true, identity: this.identity };
  }
  async rename(name: string): Promise<IdentityResult> {
    this.calls.push(`rename:${name}`);
    if (this.renameResult) return this.renameResult;
    if (!this.identity) return { ok: false, code: 'not_created' };
    this.identity = { ...this.identity, name };
    return { ok: true, identity: this.identity };
  }
  async isNoticeAccepted() { return this.accepted; }
  async acceptNotice() { this.calls.push('accept'); this.accepted = true; }
  async disable() { this.calls.push('disable'); this.accepted = false; }
  async sign() { return 'f'.repeat(128); }
}

export class FakeMutes implements MuteStore {
  items: MutedIdentity[] = [];
  async list() { return [...this.items]; }
  async has(p: string) { return this.items.some((m) => m.pubkey === p); }
  async add(pubkey: string, name: string) { this.items.push({ pubkey, name }); }
  async remove(pubkey: string) { this.items = this.items.filter((m) => m.pubkey !== pubkey); }
}

export function fakeGuards(): ChatTeardownGuards & { cleanups: Set<() => Promise<void>>; exits: Set<() => void> } {
  const cleanups = new Set<() => Promise<void>>();
  const exits = new Set<() => void>();
  return {
    cleanups, exits,
    registerCleanup: (fn) => { cleanups.add(fn); return () => { cleanups.delete(fn); }; },
    onProcessExit: (fn) => { exits.add(fn); return () => { exits.delete(fn); }; },
  };
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
