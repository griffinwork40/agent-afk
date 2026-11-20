import {
  BACKLOG_SIZE, ERROR_CODES, MAX_CLIENT_FRAME_BYTES, MAX_RELAY_FRAME_BYTES, PROTOCOL_VERSION,
  type AdminOp, type Badge, type ClientFrame, type ErrorCode, type Msg,
  type RelayFrame, type RoomMode,
} from './protocol.js';

export interface FrameParseError { code: 'bad_frame'; message: string }
export type FrameParseResult<T> = { ok: true; frame: T } | { ok: false; error: FrameParseError };
type ObjectValue = Record<string, unknown>;
const BAD: { ok: false; error: FrameParseError } = {
  ok: false, error: { code: 'bad_frame', message: 'Invalid chat frame' },
};
const object = (v: unknown): v is ObjectValue => typeof v === 'object' && v !== null && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const hex = (v: unknown, length: number): v is string => string(v) && v.length === length && new RegExp(`^[0-9a-f]{${length}}$`).test(v);
const mode = (v: unknown): v is RoomMode => v === 'open' || v === 'readonly' || v === 'closed';
const op = (v: unknown): v is AdminOp => v === 'ban' || v === 'unban' || v === 'delete' || v === 'mode';
const badge = (v: unknown): v is Badge | undefined => v === undefined || v === 'maintainer';
const code = (v: unknown): v is ErrorCode => string(v) && ERROR_CODES.some(c => c === v);

function decode(raw: string, maxBytes: number): unknown {
  // Fast reject huge strings before allocating a UTF-8 copy. Each UTF-16 unit costs >= 1 byte.
  if (typeof raw !== 'string' || raw.length > maxBytes
    || new TextEncoder().encode(raw).length > maxBytes) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}
function signed(v: ObjectValue): v is ObjectValue & { id: string; ts: number; sig: string } {
  return hex(v['id'], 32) && integer(v['ts']) && hex(v['sig'], 128);
}
function message(v: unknown): Msg | null {
  if (!object(v) || !signed(v) || !hex(v['pubkey'], 64) || !string(v['name'])
    || !string(v['text']) || !badge(v['badge'])) return null;
  return { id: v.id, ts: v.ts, sig: v.sig, pubkey: v['pubkey'], name: v['name'],
    text: v['text'], ...(v['badge'] === undefined ? {} : { badge: v['badge'] }) };
}
function client(v: ObjectValue): ClientFrame | null {
  if (v['t'] === 'ping' && integer(v['n'])) return { t: 'ping', n: v['n'] };
  if (v['t'] === 'hello') {
    if (v['v'] !== PROTOCOL_VERSION || !hex(v['pubkey'], 64) || !string(v['name'])
      || !integer(v['ts']) || !hex(v['sig'], 128)) return null;
    return { t: 'hello', v: PROTOCOL_VERSION, pubkey: v['pubkey'], name: v['name'], ts: v['ts'], sig: v['sig'] };
  }
  if (!signed(v)) return null;
  const common = { id: v.id, ts: v.ts, sig: v.sig };
  if (v['t'] === 'post' && string(v['text'])) return { t: 'post', ...common, text: v['text'] };
  if (v['t'] === 'report' && hex(v['target'], 32)) return { t: 'report', ...common, target: v['target'] };
  if (v['t'] === 'admin' && op(v['op']) && string(v['arg'])) {
    return { t: 'admin', ...common, op: v['op'], arg: v['arg'] };
  }
  return null;
}
function welcome(v: ObjectValue): RelayFrame | null {
  const you = v['you'];
  if (!integer(v['online']) || !mode(v['mode']) || !Array.isArray(v['backlog'])
    || v['backlog'].length > BACKLOG_SIZE || !object(you) || !hex(you['pubkey'], 64)
    || !string(you['name']) || !badge(you['badge'])
    || (v['notice'] !== undefined && !string(v['notice']))) return null;
  const backlog: Msg[] = [];
  for (const item of v['backlog']) {
    const m = message(item);
    if (!m) return null;
    backlog.push(m);
  }
  return { t: 'welcome', online: v['online'], mode: v['mode'], backlog,
    you: { pubkey: you['pubkey'], name: you['name'],
      ...(you['badge'] === undefined ? {} : { badge: you['badge'] }) },
    ...(v['notice'] === undefined ? {} : { notice: v['notice'] }) };
}
function relayError(v: ObjectValue): RelayFrame | null {
  if (!code(v['code']) || !string(v['message']) || (v['id'] !== undefined && !hex(v['id'], 32))
    || (v['retryAfterMs'] !== undefined && !integer(v['retryAfterMs']))) return null;
  return { t: 'error', code: v['code'], message: v['message'],
    ...(v['id'] === undefined ? {} : { id: v['id'] }),
    ...(v['retryAfterMs'] === undefined ? {} : { retryAfterMs: v['retryAfterMs'] }) };
}
function relay(v: ObjectValue): RelayFrame | null {
  switch (v['t']) {
    case 'welcome': return welcome(v);
    case 'msg': {
      const m = message(v['m']);
      return m ? { t: 'msg', m } : null;
    }
    case 'presence': return integer(v['online']) ? { t: 'presence', online: v['online'] } : null;
    case 'deleted': case 'ack': return hex(v['id'], 32) ? { t: v['t'], id: v['id'] } : null;
    case 'mode': return mode(v['mode']) ? { t: 'mode', mode: v['mode'] } : null;
    case 'error': return relayError(v);
    case 'pong': return integer(v['n']) ? { t: 'pong', n: v['n'] } : null;
    default: return null;
  }
}
/** Relay ingress. Business policy (name validity, text length, admin arg) is checked later. */
export function parseClientFrame(raw: string): FrameParseResult<ClientFrame> {
  const value = decode(raw, MAX_CLIENT_FRAME_BYTES);
  const frame = object(value) ? client(value) : null;
  return frame ? { ok: true, frame } : BAD;
}
/** Client ingress. Messages are shape-checked here, not signature-verified. */
export function parseRelayFrame(raw: string): FrameParseResult<RelayFrame> {
  const value = decode(raw, MAX_RELAY_FRAME_BYTES);
  const frame = object(value) ? relay(value) : null;
  return frame ? { ok: true, frame } : BAD;
}
