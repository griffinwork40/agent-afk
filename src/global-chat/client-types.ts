import type { AdminOp, Badge, ErrorCode, Msg, RoomMode } from './protocol.js';
import type { SecretSpan } from './secret-detect.js';

export const NOTICE_VERSION = 1;
export type ChatConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface ChatIdentity { pubkey: string; tag: string; name: string }
export interface ChatWelcome {
  online: number;
  mode: RoomMode;
  /** Only messages whose signatures were verified by the client. */
  backlog: Msg[];
  you: ChatIdentity & { badge?: Badge };
  notice?: string;
}
export interface ChatRelayError {
  code: ErrorCode;
  message: string;
  retryAfterMs?: number;
  id?: string;
}
export interface ChatClientEvents {
  onWelcome(welcome: ChatWelcome): void;
  /** Only emitted after signature verification. */
  onMessage(message: Msg): void;
  onPresence(online: number): void;
  onDeleted(id: string): void;
  onMode(mode: RoomMode): void;
  onError(error: ChatRelayError): void;
  onStatus(status: ChatConnectionStatus): void;
}
export type ChatActionResult = { ok: true; id: string } | {
  ok: false;
  code: ErrorCode | 'not_connected' | 'timeout' | 'delivery_unknown';
  message: string;
  id?: string;
  retryAfterMs?: number;
};
export type ChatPostResult = { ok: true; id: string } | {
  ok: false;
  code: Exclude<ErrorCode, 'secret_detected'> | 'not_connected' | 'timeout' | 'delivery_unknown';
  message: string;
  id?: string;
  retryAfterMs?: number;
} | {
  ok: false;
  code: 'secret_detected';
  message: string;
  /** Local detection spans, or an empty array for a relay-only secret refusal. */
  spans: SecretSpan[];
  id?: string;
  retryAfterMs?: number;
};
export interface ChatClient {
  /** Starts the connection; status and welcome are delivered through events. */
  connect(): Promise<void>;
  /** Resolves only after relay ack or failure; never renders an optimistic post. */
  post(text: string): Promise<ChatPostResult>;
  report(messageId: string): Promise<ChatActionResult>;
  admin(op: AdminOp, arg: string): Promise<ChatActionResult>;
  close(): void;
  /** Multiple subscribers are supported; returned function unsubscribes. */
  subscribe(events: Partial<ChatClientEvents>): () => void;
}
export type IdentityResult = { ok: true; identity: ChatIdentity } | {
  ok: false;
  code: 'bad_name' | 'reserved_name' | 'name_change_too_soon' | 'not_created' | 'already_exists';
  retryAfterMs?: number;
};
export interface IdentityStore {
  /** Missing file returns null; corrupt storage may reject rather than overwrite keys. */
  load(): Promise<ChatIdentity | null>;
  create(name: string): Promise<IdentityResult>;
  /** Enforces NAME_CHANGE_INTERVAL_MS locally; unchanged names are a no-op. */
  rename(name: string): Promise<IdentityResult>;
  isNoticeAccepted(version: number): Promise<boolean>;
  acceptNotice(version: number): Promise<void>;
  /** Clears notice acceptance, preserving the identity and private key. */
  disable(): Promise<void>;
  /** Rejects if no identity exists. The stored private key never leaves the module. */
  sign(canonical: string): Promise<string>;
}
export interface MutedIdentity { pubkey: string; name: string }
export interface MuteStore {
  list(): Promise<MutedIdentity[]>;
  has(pubkey: string): Promise<boolean>;
  /** Name is the display name at mute time, retained even if the user renames. */
  add(pubkey: string, name: string): Promise<void>;
  remove(pubkey: string): Promise<void>;
}
