// Contract:
// Post, report, and admin handlers for Room. Extracted to keep room.ts under
// 350 code lines. All handlers are pure async functions that take the same
// dependencies as Room methods and return RoomEffect. They are not exported
// from the package barrel -- only Room uses them.

import {
  CLOCK_SKEW_MS, MAX_LINKS, MAX_TEXT_CHARS, NAME_CHANGE_INTERVAL_MS,
  REPORT_THRESHOLD, RETENTION_MS,
  canonicalAdmin, canonicalPost, canonicalReport,
  type AdminFrame, type ClientFrame, type ErrorFrame, type Msg, type RoomMode,
} from '../protocol.js';
import { verify } from '../crypto.js';
import { sanitizeChatText, countLinks } from '../sanitize.js';
import { detectSecrets } from '../secret-detect.js';
import type { RelayStore } from './store.js';
import type { TokenBucketLimiter, SlidingWindowLimiter, Clock } from './limiter.js';
import type { ConnRecord, RelayConfig, RoomEffect } from './room-types.js';

export function err(
  code: ErrorFrame['code'],
  message: string,
  extra?: { id?: string; retryAfterMs?: number },
): ErrorFrame {
  return { t: 'error', code, message, ...extra };
}

export function makeEffect(conn: ConnRecord, overrides?: Partial<Omit<RoomEffect, 'conn'>>): RoomEffect {
  return { toSender: [], toBroadcast: [], toClose: [], conn, ...overrides };
}

interface PostDeps {
  store: RelayStore;
  config: RelayConfig;
  clock: Clock;
  postBucket: TokenBucketLimiter;
  ipWindow: SlidingWindowLimiter;
  newKeyWindow: SlidingWindowLimiter;
}

// Checks in the brief's mandated order: frame/hello already done by caller.
export async function handlePost(
  frame: Extract<ClientFrame, { t: 'post' }>,
  conn: ConnRecord,
  deps: PostDeps,
): Promise<RoomEffect> {
  const { store, config, clock, postBucket, ipWindow, newKeyWindow } = deps;
  const now = clock.now();
  const pubkey = conn.pubkey!;
  const name = conn.name!;

  // 3. ban (key and ip hash)
  const [keyBanned, ipBanned] = await Promise.all([
    store.isBannedKey(pubkey), store.isBannedIp(conn.ipHash),
  ]);
  if (keyBanned || ipBanned) return makeEffect(conn, { toSender: [err('banned', 'You are banned', { id: frame.id })] });

  // 4. room mode
  const storedMode = await store.getRoomMode();
  const mode = config.forcedMode ?? storedMode;
  const isMaintainer = config.maintainerKeys.includes(pubkey);
  if (mode === 'readonly' && !isMaintainer)
    return makeEffect(conn, { toSender: [err('readonly', 'Room is read-only', { id: frame.id })] });
  if (mode === 'closed' && !isMaintainer)
    return makeEffect(conn, { toSender: [err('closed', 'Room is closed', { id: frame.id })] });

  // 5. signature
  const canonical = canonicalPost({ id: frame.id, ts: frame.ts, name, text: frame.text });
  if (!await verify(canonical, frame.sig, pubkey))
    return makeEffect(conn, { toSender: [err('bad_signature', 'Post signature invalid', { id: frame.id })] });

  // 6. timestamp skew
  if (Math.abs(now - frame.ts) > CLOCK_SKEW_MS)
    return makeEffect(conn, { toSender: [err('stale_timestamp', 'Timestamp out of range', { id: frame.id })] });

  // 7. duplicate id
  if (await store.getMessageById(frame.id))
    return makeEffect(conn, { toSender: [err('duplicate', 'Duplicate message id', { id: frame.id })] });

  // 8. sanitize then reject if text differs
  if (sanitizeChatText(frame.text) !== frame.text)
    return makeEffect(conn, { toSender: [err('bad_frame', 'Text must be pre-sanitized', { id: frame.id })] });

  // 9. length
  if (frame.text.length > MAX_TEXT_CHARS)
    return makeEffect(conn, { toSender: [err('too_long', 'Message too long', { id: frame.id })] });

  // 10. links
  if (countLinks(frame.text) > MAX_LINKS)
    return makeEffect(conn, { toSender: [err('too_many_links', 'Too many links', { id: frame.id })] });

  // 11. secret detection
  if (detectSecrets(frame.text).length > 0)
    return makeEffect(conn, { toSender: [{ t: 'error', code: 'secret_detected', message: 'Secret detected', id: frame.id }] });

  // 12. rate limits: ip first, then per-key bucket, then new-key hourly
  if (!ipWindow.allow(conn.ipHash)) {
    return makeEffect(conn, { toSender: [err('rate_limited', 'IP rate limit exceeded',
      { id: frame.id, retryAfterMs: ipWindow.retryAfterMs(conn.ipHash) })] });
  }
  if (!postBucket.allow(pubkey)) {
    return makeEffect(conn, { toSender: [err('rate_limited', 'Post rate limit exceeded',
      { id: frame.id, retryAfterMs: postBucket.retryAfterMs(pubkey) })] });
  }
  const keyRecord = await store.getKeyRecord(pubkey);
  if (keyRecord && (now - keyRecord.firstSeenAt) < 24 * 60 * 60 * 1000) {
    if (!newKeyWindow.allow(pubkey)) {
      return makeEffect(conn, { toSender: [err('rate_limited', 'New account post limit exceeded',
        { id: frame.id, retryAfterMs: newKeyWindow.retryAfterMs(pubkey) })] });
    }
  }

  // Store, ack, broadcast
  const badge = isMaintainer ? 'maintainer' : undefined;
  const msg: Msg = {
    id: frame.id, ts: frame.ts, pubkey, name, text: frame.text, sig: frame.sig,
    ...(badge ? { badge } : {}),
  };
  await store.insertMessage(msg);
  return makeEffect(conn, {
    toSender: [{ t: 'ack', id: frame.id }],
    toBroadcast: [{ t: 'msg', m: msg }],
  });
}

export async function handleReport(
  frame: Extract<ClientFrame, { t: 'report' }>,
  conn: ConnRecord,
  store: RelayStore,
  clock: Clock,
): Promise<RoomEffect> {
  const pubkey = conn.pubkey!;
  const canonical = canonicalReport({ id: frame.id, ts: frame.ts, target: frame.target });
  if (!await verify(canonical, frame.sig, pubkey))
    return makeEffect(conn, { toSender: [err('bad_signature', 'Report signature invalid')] });
  if (Math.abs(clock.now() - frame.ts) > CLOCK_SKEW_MS)
    return makeEffect(conn, { toSender: [err('stale_timestamp', 'Timestamp out of range')] });

  const target = await store.getMessageById(frame.target);
  if (!target || (target as unknown as { deleted: boolean }).deleted)
    return makeEffect(conn, { toSender: [err('unknown_target', 'Message not found or deleted')] });
  if (target.pubkey === pubkey)
    return makeEffect(conn, { toSender: [err('forbidden', 'Cannot report your own message')] });

  await store.addReport(frame.target, pubkey);
  if (await store.countReporters(frame.target) >= REPORT_THRESHOLD) {
    await store.markDeleted(frame.target);
    return makeEffect(conn, { toBroadcast: [{ t: 'deleted', id: frame.target }] });
  }
  return makeEffect(conn);
}

export async function handleAdmin(
  frame: AdminFrame,
  conn: ConnRecord,
  store: RelayStore,
  config: RelayConfig,
  clock: Clock,
  allConns: ReadonlyMap<string, ConnRecord>,
): Promise<RoomEffect> {
  const pubkey = conn.pubkey!;
  if (!config.maintainerKeys.includes(pubkey))
    return makeEffect(conn, { toSender: [err('forbidden', 'Admin access denied')] });

  const canonical = canonicalAdmin({ id: frame.id, ts: frame.ts, op: frame.op, arg: frame.arg });
  if (!await verify(canonical, frame.sig, pubkey))
    return makeEffect(conn, { toSender: [err('bad_signature', 'Admin signature invalid')] });
  if (Math.abs(clock.now() - frame.ts) > CLOCK_SKEW_MS)
    return makeEffect(conn, { toSender: [err('stale_timestamp', 'Timestamp out of range')] });

  if (frame.op === 'ban') return adminBan(frame.arg, conn, store, allConns);
  if (frame.op === 'unban') return adminUnban(frame.arg, conn, store);
  if (frame.op === 'delete') return adminDelete(frame.arg, conn, store);
  if (frame.op === 'mode') return adminMode(frame.arg, conn, store);
  return makeEffect(conn, { toSender: [err('bad_frame', 'Unknown admin op')] });
}

async function adminBan(
  targetKey: string,
  conn: ConnRecord,
  store: RelayStore,
  allConns: ReadonlyMap<string, ConnRecord>,
): Promise<RoomEffect> {
  if (!/^[0-9a-f]{64}$/.test(targetKey))
    return makeEffect(conn, { toSender: [err('bad_frame', 'Invalid pubkey for ban')] });
  const liveConnIds: string[] = [];
  let ipHash = '';
  for (const [cid, c] of allConns) {
    if (c.pubkey === targetKey) { liveConnIds.push(cid); ipHash = c.ipHash; }
  }
  await store.addBan(targetKey, ipHash);
  return makeEffect(conn, {
    toClose: liveConnIds,
    // Never broadcast a terminal banned error to innocent participants.
    toConnections: liveConnIds.map(connId => ({ connId,
      frame: { t: 'error', code: 'banned', message: 'You have been banned' },
    })),
  });
}

async function adminUnban(targetKey: string, conn: ConnRecord, store: RelayStore): Promise<RoomEffect> {
  if (!/^[0-9a-f]{64}$/.test(targetKey))
    return makeEffect(conn, { toSender: [err('bad_frame', 'Invalid pubkey for unban')] });
  await store.removeBan(targetKey);
  return makeEffect(conn);
}

async function adminDelete(messageId: string, conn: ConnRecord, store: RelayStore): Promise<RoomEffect> {
  if (!/^[0-9a-f]{32}$/.test(messageId))
    return makeEffect(conn, { toSender: [err('bad_frame', 'Invalid message id')] });
  await store.markDeleted(messageId);
  return makeEffect(conn, { toBroadcast: [{ t: 'deleted', id: messageId }] });
}

async function adminMode(arg: string, conn: ConnRecord, store: RelayStore): Promise<RoomEffect> {
  if (arg !== 'open' && arg !== 'readonly' && arg !== 'closed')
    return makeEffect(conn, { toSender: [err('bad_frame', 'Invalid mode')] });
  await store.setRoomMode(arg as RoomMode);
  return makeEffect(conn, { toBroadcast: [{ t: 'mode', mode: arg as RoomMode }] });
}

// Also export retention prune helper used by room.ts
export { RETENTION_MS, NAME_CHANGE_INTERVAL_MS };
