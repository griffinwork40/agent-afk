import {
  BACKLOG_SIZE, CLOCK_SKEW_MS, NAME_CHANGE_INTERVAL_MS,
  canonicalHello, type ClientFrame,
} from '../protocol.js';
import { verify } from '../crypto.js';
import { validateName } from '../names.js';
import { parseClientFrame } from '../protocol.parse.js';
import type { RelayStore } from './store.js';
import type { Clock } from './limiter.js';
import { TokenBucketLimiter, SlidingWindowLimiter } from './limiter.js';
import type { ConnRecord, RelayConfig, RoomEffect } from './room-types.js';
import {
  err, makeEffect, handlePost, handleReport, handleAdmin, RETENTION_MS,
} from './room-handlers.js';

// Invariant:
// All per-connection state that must survive DO hibernation lives in ConnRecord
// (passed in and returned on every call). The Room instance holds only
// in-memory rate-limit counters (acceptable to lose on hibernation) and
// injected store/clock/config references.
//
// Fan-out: the adapter calls getWebSockets() to enumerate live connections for
// broadcasting. The Room does not hold WebSocket handles.

const POST_INTERVAL_MS = 3_000;
const POST_BURST = 5;
const IP_WINDOW_MS = 60_000;
const IP_LIMIT = 60;
const NEW_KEY_WINDOW_MS = 60 * 60 * 1_000;
const NEW_KEY_LIMIT = 20;
export const KEY_REGISTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Twenty new identities/hour/address tolerates shared networks, but caps registry churn.
export const KEY_REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
export const KEY_REGISTRATION_LIMIT = 20;

export class Room {
  // In-memory rate limiters -- intentionally not persisted (see Invariant above).
  private readonly postBucket: TokenBucketLimiter;
  private readonly ipWindow: SlidingWindowLimiter;
  private readonly newKeyWindow: SlidingWindowLimiter;
  private readonly registrations: SlidingWindowLimiter;

  constructor(
    private readonly store: RelayStore,
    private readonly config: RelayConfig,
    private readonly clock: Clock,
  ) {
    this.postBucket = new TokenBucketLimiter(POST_INTERVAL_MS, POST_BURST, clock);
    this.ipWindow = new SlidingWindowLimiter(IP_WINDOW_MS, IP_LIMIT, clock);
    this.newKeyWindow = new SlidingWindowLimiter(NEW_KEY_WINDOW_MS, NEW_KEY_LIMIT, clock);
    this.registrations = new SlidingWindowLimiter(KEY_REGISTRATION_WINDOW_MS, KEY_REGISTRATION_LIMIT, clock);
  }

  /** One bounded physical prune batch. Adapter alarms continue while expired rows remain. */
  async onAlarm(): Promise<void> {
    await this.store.pruneOlderThan(this.clock.now() - RETENTION_MS);
    await this.store.pruneKeyRecords(this.clock.now() - KEY_REGISTRY_RETENTION_MS);
    await this.store.pruneActionIds(this.clock.now());
  }

  async nextMessageExpiry(): Promise<number | null> {
    const oldest = await this.store.getOldestMessageTimestamp();
    // Prune uses strict <; add one millisecond so the oldest row is actually expired.
    const keyOldest = await this.store.getOldestKeyTimestamp();
    const next = Math.min(oldest === null ? Infinity : oldest + RETENTION_MS + 1,
      keyOldest === null ? Infinity : keyOldest + KEY_REGISTRY_RETENTION_MS + 1,
      await this.store.getOldestActionExpiry() ?? Infinity);
    return Number.isFinite(next) ? Math.max(this.clock.now() + 1, next) : null;
  }

  onConnect(_connId: string, ipHash: string): ConnRecord {
    return { pubkey: null, name: null, ipHash, helloOk: false };
  }

  async onMessage(
    connId: string,
    raw: string,
    conn: ConnRecord,
    allConns: ReadonlyMap<string, ConnRecord>,
  ): Promise<RoomEffect> {
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) return makeEffect(conn, { toSender: [err('bad_frame', parsed.error.message)] });
    const frame = parsed.frame;
    if (frame.t === 'ping') return makeEffect(conn, { toSender: [{ t: 'pong', n: frame.n }] });
    if (frame.t === 'hello') return this.handleHello(connId, frame, conn, allConns);
    if (!conn.helloOk) return makeEffect(conn, { toSender: [err('not_hello', 'Send hello first', { id: frame.id })] });
    if (frame.t === 'post') {
      return handlePost(frame, conn, {
        store: this.store, config: this.config, clock: this.clock,
        postBucket: this.postBucket, ipWindow: this.ipWindow, newKeyWindow: this.newKeyWindow,
      });
    }
    if (frame.t === 'report' || frame.t === 'admin') {
      const effect = frame.t === 'report'
        ? await handleReport(frame, conn, this.store, this.clock)
        : await handleAdmin(frame, conn, this.store, this.config, this.clock, allConns);
      // Every signed action has a request id; clients await its ack or error.
      const failed = effect.toSender.some(f => f.t === 'error');
      effect.toSender = effect.toSender.map(f => f.t === 'error' ? { ...f, id: frame.id } : f);
      if (!failed) effect.toSender.push({ t: 'ack', id: frame.id });
      return effect;
    }
    return makeEffect(conn, { toSender: [err('bad_frame', 'Unknown frame type')] });
  }

  async onClose(
    connId: string,
    conn: ConnRecord,
    allConns: ReadonlyMap<string, ConnRecord>,
  ): Promise<RoomEffect> {
    if (!conn.helloOk) return makeEffect(conn);
    const prevOnline = countDistinctKeys(allConns);
    const newOnline = countDistinctKeysExcluding(allConns, conn.pubkey, connId);
    if (newOnline !== prevOnline) {
      return makeEffect(conn, { toBroadcast: [{ t: 'presence', online: newOnline }] });
    }
    return makeEffect(conn);
  }

  private async handleHello(
    connId: string,
    frame: Extract<ClientFrame, { t: 'hello' }>,
    conn: ConnRecord,
    allConns: ReadonlyMap<string, ConnRecord>,
  ): Promise<RoomEffect> {
    if (conn.helloOk) return makeEffect(conn, {
      toSender: [err('bad_frame', 'Hello already completed')], toClose: [connId],
    });
    const now = this.clock.now();
    const isMaintainer = this.config.maintainerKeys.includes(frame.pubkey);

    // IP connection limit (5 concurrent per ip hash)
    if (countConnsByIp(allConns, conn.ipHash, connId) >= this.config.maxConnsPerIp) {
      return makeEffect(conn, {
        toSender: [err('rate_limited', 'Too many connections from this IP')], toClose: [connId],
      });
    }

    // Ban check
    const [keyBanned, ipBanned] = await Promise.all([
      this.store.isBannedKey(frame.pubkey), this.store.isBannedIp(conn.ipHash),
    ]);
    if (keyBanned || ipBanned) {
      return makeEffect(conn, { toSender: [err('banned', 'You are banned')], toClose: [connId] });
    }

    // Room mode
    const storedMode = await this.store.getRoomMode();
    const mode = this.config.forcedMode ?? storedMode;
    if (mode === 'closed' && !isMaintainer) {
      return makeEffect(conn, { toSender: [err('closed', 'Room is closed')], toClose: [connId] });
    }

    // Name validation
    const nameVal = validateName(frame.name);
    if (!nameVal.ok) {
      if (nameVal.code === 'bad_name') return makeEffect(conn, { toSender: [err('bad_name', 'Invalid name format')] });
      if (!isMaintainer) return makeEffect(conn, { toSender: [err('reserved_name', 'Name is reserved')] });
    }

    // Signature
    const canonical = canonicalHello({ ts: frame.ts, pubkey: frame.pubkey, name: frame.name });
    if (!await verify(canonical, frame.sig, frame.pubkey))
      return makeEffect(conn, { toSender: [err('bad_signature', 'Hello signature invalid')] });

    // Timestamp skew
    if (Math.abs(now - frame.ts) > CLOCK_SKEW_MS)
      return makeEffect(conn, { toSender: [err('stale_timestamp', 'Timestamp too far from server time')] });

    // Key registry + rename rule
    let keyRecord = await this.store.getKeyRecord(frame.pubkey);
    if (!keyRecord) {
      if (!this.registrations.allow(conn.ipHash)) return makeEffect(conn, {
        toSender: [err('rate_limited', 'New identity registration limit exceeded',
          { retryAfterMs: this.registrations.retryAfterMs(conn.ipHash) })], toClose: [connId],
      });
      keyRecord = { pubkey: frame.pubkey, name: frame.name, firstSeenAt: now, nameChangedAt: 0, lastSeenAt: now };
    } else if (keyRecord.name !== frame.name) {
      const baseline = keyRecord.nameChangedAt > 0 ? keyRecord.nameChangedAt : keyRecord.firstSeenAt;
      const elapsed = now - baseline;
      if (elapsed < NAME_CHANGE_INTERVAL_MS && !isMaintainer) {
        return makeEffect(conn, { toSender: [err('name_change_too_soon', 'Name change too soon',
          { retryAfterMs: NAME_CHANGE_INTERVAL_MS - elapsed })] });
      }
      keyRecord = { ...keyRecord, name: frame.name, nameChangedAt: now };
    }
    await this.store.upsertKeyRecord({ ...keyRecord, lastSeenAt: now });

    // Opportunistic prune (bounded -- store implementations may add LIMIT internally)
    await this.onAlarm();

    const backlog = await this.store.getBacklog(BACKLOG_SIZE);
    const updatedConn: ConnRecord = { ...conn, pubkey: frame.pubkey, name: frame.name, helloOk: true };
    const prevOnline = countDistinctKeys(allConns);
    const newOnline = countDistinctKeysIncluding(allConns, frame.pubkey);

    const welcome: RoomEffect['toSender'][number] = {
      t: 'welcome', online: newOnline, mode, backlog,
      you: { pubkey: frame.pubkey, name: frame.name, ...(isMaintainer ? { badge: 'maintainer' } : {}) },
      ...(this.config.notice ? { notice: this.config.notice } : {}),
    };
    const effects = makeEffect(updatedConn, { toSender: [welcome] });
    if (newOnline !== prevOnline) effects.toBroadcast.push({ t: 'presence', online: newOnline });
    return effects;
  }
}

export function countDistinctKeys(conns: ReadonlyMap<string, ConnRecord>): number {
  const keys = new Set<string>();
  for (const c of conns.values()) { if (c.helloOk && c.pubkey) keys.add(c.pubkey); }
  return keys.size;
}

export function countDistinctKeysExcluding(
  conns: ReadonlyMap<string, ConnRecord>,
  excludeKey: string | null,
  excludeConnId: string,
): number {
  const keys = new Set<string>();
  for (const [cid, c] of conns) {
    if (cid !== excludeConnId && c.helloOk && c.pubkey) keys.add(c.pubkey);
  }
  // Exclude the socket, not its key: another socket may still own that key.
  void excludeKey;
  return keys.size;
}

function countDistinctKeysIncluding(
  conns: ReadonlyMap<string, ConnRecord>,
  includeKey: string,
): number {
  const keys = new Set<string>();
  for (const c of conns.values()) { if (c.helloOk && c.pubkey) keys.add(c.pubkey); }
  keys.add(includeKey);
  return keys.size;
}

export function countConnsByIp(
  conns: ReadonlyMap<string, ConnRecord>,
  ipHash: string,
  selfConnId: string,
): number {
  let count = 0;
  for (const [cid, c] of conns) { if (cid !== selfConnId && c.ipHash === ipHash) count++; }
  return count;
}
