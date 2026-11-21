export const PROTOCOL_VERSION = 1;
export const PROTOCOL_ID = 'afk-global-chat/v1';
export const ROOM = 'global';
export const MAX_TEXT_CHARS = 500;
export const MAX_LINKS = 2;
/** Cap on a frame a client sends. A post is at most 500 chars plus a 128-hex signature. */
export const MAX_CLIENT_FRAME_BYTES = 4096;
/** Cap on a frame the relay sends. A welcome carries up to BACKLOG_SIZE full messages. */
export const MAX_RELAY_FRAME_BYTES = 262_144;
export const BACKLOG_SIZE = 50;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 120_000;
export const NAME_PATTERN = /^[a-z0-9_-]{2,16}$/;
export const REPORT_THRESHOLD = 3;
export const NAME_CHANGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RoomMode = 'open' | 'readonly' | 'closed';
export type Badge = 'maintainer';
export type AdminOp = 'ban' | 'unban' | 'delete' | 'mode';
export const ERROR_CODES = [
  'bad_frame', 'bad_signature', 'stale_timestamp', 'duplicate', 'not_hello',
  'bad_name', 'reserved_name', 'name_change_too_soon', 'too_long',
  'too_many_links', 'secret_detected', 'rate_limited', 'banned', 'readonly',
  'closed', 'forbidden', 'unknown_target',
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export interface Msg {
  id: string;
  ts: number;
  pubkey: string;
  name: string;
  text: string;
  sig: string;
  badge?: Badge;
}
export interface HelloFrame {
  t: 'hello'; v: typeof PROTOCOL_VERSION; pubkey: string; name: string; ts: number; sig: string;
}
export interface PostFrame { t: 'post'; id: string; ts: number; text: string; sig: string }
export interface ReportFrame { t: 'report'; id: string; ts: number; target: string; sig: string }
export interface AdminFrame { t: 'admin'; id: string; ts: number; op: AdminOp; arg: string; sig: string }
export interface PingFrame { t: 'ping'; n: number }
export type ClientFrame = HelloFrame | PostFrame | ReportFrame | AdminFrame | PingFrame;
export interface WelcomeFrame {
  t: 'welcome'; online: number; mode: RoomMode; backlog: Msg[];
  you: { pubkey: string; name: string; badge?: Badge }; notice?: string;
}
export interface MessageFrame { t: 'msg'; m: Msg }
export interface PresenceFrame { t: 'presence'; online: number }
export interface DeletedFrame { t: 'deleted'; id: string }
export interface ModeFrame { t: 'mode'; mode: RoomMode }
export interface AckFrame { t: 'ack'; id: string }
export interface ErrorFrame {
  t: 'error'; code: ErrorCode; message: string; id?: string; retryAfterMs?: number;
}
export interface PongFrame { t: 'pong'; n: number }
export type RelayFrame = WelcomeFrame | MessageFrame | PresenceFrame | DeletedFrame
  | ModeFrame | AckFrame | ErrorFrame | PongFrame;

// Callers validate fields before signing. Room is fixed to prevent cross-room replay.
export function canonicalHello(fields: Pick<HelloFrame, 'ts' | 'pubkey' | 'name'>): string {
  return [PROTOCOL_ID, 'hello', ROOM, fields.ts, fields.pubkey, fields.name].join('\n');
}
export function canonicalPost(fields: Pick<Msg, 'id' | 'ts' | 'name' | 'text'>): string {
  return [PROTOCOL_ID, 'post', ROOM, fields.id, fields.ts, fields.name, fields.text].join('\n');
}
export function canonicalReport(fields: Pick<ReportFrame, 'id' | 'ts' | 'target'>): string {
  return [PROTOCOL_ID, 'report', ROOM, fields.id, fields.ts, fields.target].join('\n');
}
export function canonicalAdmin(fields: Pick<AdminFrame, 'id' | 'ts' | 'op' | 'arg'>): string {
  return [PROTOCOL_ID, 'admin', ROOM, fields.id, fields.ts, fields.op, fields.arg].join('\n');
}
