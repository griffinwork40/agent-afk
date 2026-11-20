import {
  BACKLOG_SIZE, CLOCK_SKEW_MS, MAX_LINKS, MAX_TEXT_CHARS,
  NAME_CHANGE_INTERVAL_MS, REPORT_THRESHOLD, RETENTION_MS,
  canonicalAdmin, canonicalHello, canonicalPost, canonicalReport,
  type AdminFrame, type ClientFrame, type ErrorFrame, type Msg,
  type RoomMode,
} from '../protocol.js';
import { verify } from '../crypto.js';
import { validateName } from '../names.js';
import { sanitizeChatText, countLinks } from '../sanitize.js';
import { detectSecrets } from '../secret-detect.js';
import { parseClientFrame } from '../protocol.parse.js';
import type { RelayStore } from './store.js';
import type { Clock } from './limiter.js';
import { TokenBucketLimiter, SlidingWindowLimiter } from './limiter.js';
import type { ConnRecord, RelayConfig, RoomEffect } from './room-types.js';

// Invariant:
// All per-connection state that must survive DO hibernation is in ConnRecord
// (passed in and returned on every call). The Room instance holds only
// in-memory rate-limit counters (acceptable to lose on hibernation) and
// the injected store/clock/config references.
//
// Fan-out: the adapter calls getHellodKeys() to enumerate live connections
// for broadcasting. The Room does not hold WebSocket handles.

const POST_INTERVAL_MS = 3_000;
const POST_BURST = 5;
const IP_WINDOW_MS = 60_000;
const IP_LIMIT = 60;
const NEW_KEY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const NEW_KEY_LIMIT = 20;
const PRUNE_ON_HELLO_LIMIT = 20; // max messages pruned per hello event

function err(code: ErrorFrame['code'], message: string, extra?: { id?: string; retryAfterMs?: number }): ErrorFrame {
  return { t: 'error', code, message, ...extra };
}

function makeEffect(conn: ConnRecord, overrides?: Partial<Omit<RoomEffect, 'conn'>>): RoomEffect {
  return { toSender: [], toBroadcast: [], toClose: [], conn, ...overrides };
}

export class Room {
  // In-memory rate limiters -- intentionally not persisted (see Invariant above).
  private readonly postBucket: TokenBucketLimiter;
  private readonly ipWindow: SlidingWindowLimiter;
  private readonly newKeyWindow: SlidingWindowLimiter;

  constructor(
    private readonly store: RelayStore,
    private readonly config: RelayConfig,
    private readonly clock: Clock,
  ) {
    this.postBucket = new TokenBucketLimiter(POST_INTERVAL_MS, POST_BURST, clock);
    this.ipWindow = new SlidingWindowLimiter(IP_WINDOW_MS, IP_LIMIT, clock);
    this.newKeyWindow = new SlidingWindowLimiter(NEW_KEY_WINDOW_MS, NEW_KEY_LIMIT, clock);
  }

  // -------------------------------------------------------------------------
  // onConnect: called when a new WebSocket connection is accepted.
  // Returns the initial ConnRecord to persist as the attachment.
  // -------------------------------------------------------------------------
  onConnect(connId: string, ipHash: string): ConnRecord {
    void connId; // connId reserved for future use
    return { pubkey: null, name: null, ipHash, helloOk: false };
  }

  // -------------------------------------------------------------------------
  // onMessage: main dispatch
  // -------------------------------------------------------------------------
  async onMessage(
    connId: string,
    raw: string,
    conn: ConnRecord,
    /** All currently hello'd connection records (for presence counting, fan-out metadata). */
    allConns: ReadonlyMap<string, ConnRecord>,
  ): Promise<RoomEffect> {
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) {
      return makeEffect(conn, { toSender: [err('bad_frame', parsed.error.message)] });
    }
    const frame = parsed.frame;

    if (frame.t === 'ping') {
      return makeEffect(conn, { toSender: [{ t: 'pong', n: frame.n }] });
    }

    if (frame.t === 'hello') {
      return this.handleHello(connId, frame, conn, allConns);
    }

    if (!conn.helloOk) {
      return makeEffect(conn, { toSender: [err('not_hello', 'Send hello first')] });
    }

    if (frame.t === 'post') return this.handlePost(frame, conn, allConns);
    if (frame.t === 'report') return this.handleReport(frame, conn);
    if (frame.t === 'admin') return this.handleAdmin(frame, conn, allConns);

    // Should be unreachable given frame types
    return makeEffect(conn, { toSender: [err('bad_frame', 'Unknown frame type')] });
  }

  // -------------------------------------------------------------------------
  // onClose: update presence if the connection was hello'd
  // -------------------------------------------------------------------------
  async onClose(
    _connId: string,
    conn: ConnRecord,
    allConns: ReadonlyMap<string, ConnRecord>,
  ): Promise<RoomEffect> {
    if (!conn.helloOk) return makeEffect(conn);
    const online = this.countOnline(allConns, null, conn.pubkey);
    if (online !== this.countOnline(allConns, null, null) - 1) {
      // presence changed: the closed conn had a unique key
    }
    const prevOnline = countDistinctKeys(allConns);
    const newOnline = countDistinctKeysExcluding(allConns, conn.pubkey, _connId);
    if (newOnline !== prevOnline) {
      return makeEffect(conn, { toBroadcast: [{ t: 'presence', online: newOnline }] });
    }
    return makeEffect(conn);
  }

  // -------------------------------------------------------------------------
  // handleHello
  // -------------------------------------------------------------------------
  private async handleHello(
    connId: string,
    frame: Extract<ClientFrame, { t: 'hello' }>,
    conn: ConnRecord,
    allConns: ReadonlyMap<string, ConnRecord>,
  ): Promise<RoomEffect> {
    const now = this.clock.now();
    const isMaintainer = this.config.maintainerKeys.includes(frame.pubkey);

    // Check IP connection limit (5 concurrent per ip hash)
    const ipConnCount = countConnsByIp(allConns, conn.ipHash, connId);
    if (ipConnCount >= this.config.maxConnsPerIp) {
      return makeEffect(conn, {
        toSender: [err('rate_limited', 'Too many connections from this IP')],
        toClose: [connId],
      });
    }

    // Check ban (key and ip hash)
    const [keyBanned, ipBanned] = await Promise.all([
      this.store.isBannedKey(frame.pubkey),
      this.store.isBannedIp(conn.ipHash),
    ]);
    if (keyBanned || ipBanned) {
      return makeEffect(conn, {
        toSender: [err('banned', 'You are banned')],
        toClose: [connId],
      });
    }

    // Check room mode
    const storedMode = await this.store.getRoomMode();
    const mode = this.config.forcedMode ?? storedMode;
    if (mode === 'closed' && !isMaintainer) {
      return makeEffect(conn, {
        toSender: [err('closed', 'Room is closed')],
        toClose: [connId],
      });
    }

    // Validate name
    const nameValidation = validateName(frame.name);
    if (!nameValidation.ok && !isMaintainer) {
      return makeEffect(conn, { toSender: [err(nameValidation.code, 'Invalid name')] });
    }
    if (!nameValidation.ok && isMaintainer && nameValidation.code === 'bad_name') {
      // Even maintainers need a structurally valid name
      return makeEffect(conn, { toSender: [err('bad_name', 'Invalid name format')] });
    }

    // Verify signature
    const canonical = canonicalHello({ ts: frame.ts, pubkey: frame.pubkey, name: frame.name });
    const sigOk = await verify(canonical, frame.sig, frame.pubkey);
    if (!sigOk) {
      return makeEffect(conn, { toSender: [err('bad_signature', 'Hello signature invalid')] });
    }

    // Timestamp skew
    if (Math.abs(now - frame.ts) > CLOCK_SKEW_MS) {
      return makeEffect(conn, { toSender: [err('stale_timestamp', 'Timestamp too far from server time')] });
    }

    // Key registry: first-seen, name, rename rule
    let keyRecord = await this.store.getKeyRecord(frame.pubkey);
    const isNewKey = keyRecord === null;
    if (!keyRecord) {
      keyRecord = { pubkey: frame.pubkey, name: frame.name, firstSeenAt: now, nameChangedAt: 0 };
    } else if (keyRecord.name !== frame.name) {
      // Rename attempt: nameChangedAt=0 means the name was set at first-seen (counts as a change).
      // Any subsequent rename within 24h is rejected unless maintainer.
      const baseline = keyRecord.nameChangedAt > 0 ? keyRecord.nameChangedAt : keyRecord.firstSeenAt;
      const timeSinceChange = now - baseline;
      if (timeSinceChange < NAME_CHANGE_INTERVAL_MS && !isMaintainer) {
        const retryAfterMs = NAME_CHANGE_INTERVAL_MS - timeSinceChange;
        return makeEffect(conn, { toSender: [err('name_change_too_soon', 'Name change too soon', { retryAfterMs })] });
      }
      keyRecord = { ...keyRecord, name: frame.name, nameChangedAt: now };
    }
    // Reserved name check (after rename check, so rename error takes priority)
    if (!nameValidation.ok && nameValidation.code === 'reserved_name' && !isMaintainer) {
      return makeEffect(conn, { toSender: [err('reserved_name', 'Name is reserved')] });
    }

    await this.store.upsertKeyRecord(keyRecord);

    // Opportunistic prune (bounded)
    const cutoff = now - RETENTION_MS;
    await this.store.pruneOlderThan(cutoff); // MemoryStore prunes all; SQLite store will LIMIT

    // Load backlog
    const backlog = await this.store.getBacklog(BACKLOG_SIZE);

    // Update conn record
    const updatedConn: ConnRecord = { ...conn, pubkey: frame.pubkey, name: frame.name, helloOk: true };

    // Presence: count after this conn is hello'd
    const prevOnline = countDistinctKeys(allConns);
    // Include this connection in the new count
    const newOnline = countDistinctKeysIncluding(allConns, frame.pubkey, connId);

    const welcome: RoomEffect['toSender'][number] = {
      t: 'welcome',
      online: newOnline,
      mode,
      backlog,
      you: { pubkey: frame.pubkey, name: frame.name, ...(isMaintainer ? { badge: 'maintainer' } : {}) },
      ...(this.config.notice ? { notice: this.config.notice } : {}),
    };

    const effects: RoomEffect = makeEffect(updatedConn, { toSender: [welcome] });

    // Broadcast presence change if this key was not already online
    if (newOnline !== prevOnline) {
      effects.toBroadcast.push({ t: 'presence', online: newOnline });
    }

    // New key hourly limit check (after storing, to avoid double-checking on reconnect)
    if (isNewKey) {
      // Record the new-key hourly window -- but this is for posts, handled in handlePost
      void isNewKey; // just for prune-on-hello logic
    }

    return effects;
  }

  // -------------------------------------------------------------------------
  // handlePost -- checks in brief order
  // -------------------------------------------------------------------------
  private async handlePost(
    frame: Extract<ClientFrame, { t: 'post' }>,
    conn: ConnRecord,
    allConns: ReadonlyMap<string, ConnRecord>,
  ): Promise<RoomEffect> {
    const now = this.clock.now();
    const pubkey = conn.pubkey!;
    const name = conn.name!;

    // 1. frame size+shape already checked by parseClientFrame
    // 2. hello done -- checked before dispatch

    // 3. ban (key and ip hash)
    const [keyBanned, ipBanned] = await Promise.all([
      this.store.isBannedKey(pubkey),
      this.store.isBannedIp(conn.ipHash),
    ]);
    if (keyBanned || ipBanned) {
      return makeEffect(conn, { toSender: [err('banned', 'You are banned')] });
    }

    // 4. room mode
    const storedMode = await this.store.getRoomMode();
    const mode = this.config.forcedMode ?? storedMode;
    const isMaintainer = this.config.maintainerKeys.includes(pubkey);
    if (mode === 'readonly' && !isMaintainer) {
      return makeEffect(conn, { toSender: [err('readonly', 'Room is read-only', { id: frame.id })] });
    }
    if (mode === 'closed' && !isMaintainer) {
      return makeEffect(conn, { toSender: [err('closed', 'Room is closed', { id: frame.id })] });
    }

    // 5. signature
    const canonical = canonicalPost({ id: frame.id, ts: frame.ts, name, text: frame.text });
    const sigOk = await verify(canonical, frame.sig, pubkey);
    if (!sigOk) {
      return makeEffect(conn, { toSender: [err('bad_signature', 'Post signature invalid', { id: frame.id })] });
    }

    // 6. timestamp skew
    if (Math.abs(now - frame.ts) > CLOCK_SKEW_MS) {
      return makeEffect(conn, { toSender: [err('stale_timestamp', 'Timestamp out of range', { id: frame.id })] });
    }

    // 7. duplicate id
    const existing = await this.store.getMessageById(frame.id);
    if (existing) {
      return makeEffect(conn, { toSender: [err('duplicate', 'Duplicate message id', { id: frame.id })] });
    }

    // 8. sanitize then reject if text differs
    const sanitized = sanitizeChatText(frame.text);
    if (sanitized !== frame.text) {
      return makeEffect(conn, { toSender: [err('bad_frame', 'Text must be pre-sanitized', { id: frame.id })] });
    }

    // 9. length
    if (frame.text.length > MAX_TEXT_CHARS) {
      return makeEffect(conn, { toSender: [err('too_long', 'Message too long', { id: frame.id })] });
    }

    // 10. links
    if (countLinks(frame.text) > MAX_LINKS) {
      return makeEffect(conn, { toSender: [err('too_many_links', 'Too many links', { id: frame.id })] });
    }

    // 11. secret detection
    const spans = detectSecrets(frame.text);
    if (spans.length > 0) {
      return makeEffect(conn, { toSender: [{ t: 'error', code: 'secret_detected', message: 'Secret detected in message', id: frame.id }] });
    }

    // 12. rate limits
    if (!this.ipWindow.allow(conn.ipHash)) {
      const retryAfterMs = this.ipWindow.retryAfterMs(conn.ipHash);
      return makeEffect(conn, { toSender: [err('rate_limited', 'IP rate limit exceeded', { id: frame.id, retryAfterMs })] });
    }
    if (!this.postBucket.allow(pubkey)) {
      const retryAfterMs = this.postBucket.retryAfterMs(pubkey);
      return makeEffect(conn, { toSender: [err('rate_limited', 'Post rate limit exceeded', { id: frame.id, retryAfterMs })] });
    }
    // New-key hourly quota
    const keyRecord = await this.store.getKeyRecord(pubkey);
    if (keyRecord) {
      const age = now - keyRecord.firstSeenAt;
      if (age < 24 * 60 * 60 * 1000) {
        if (!this.newKeyWindow.allow(pubkey)) {
          const retryAfterMs = this.newKeyWindow.retryAfterMs(pubkey);
          return makeEffect(conn, { toSender: [err('rate_limited', 'New account post limit exceeded', { id: frame.id, retryAfterMs })] });
        }
      }
    }

    // Store, ack, broadcast
    const badge = isMaintainer ? 'maintainer' : undefined;
    const msg: Msg = {
      id: frame.id, ts: frame.ts, pubkey, name,
      text: frame.text, sig: frame.sig,
      ...(badge ? { badge } : {}),
    };
    await this.store.insertMessage(msg);

    const effects = makeEffect(conn, {
      toSender: [{ t: 'ack', id: frame.id }],
      toBroadcast: [{ t: 'msg', m: msg }],
    });

    void allConns; // used for presence in hello/close
    return effects;
  }

  // -------------------------------------------------------------------------
  // handleReport
  // -------------------------------------------------------------------------
  private async handleReport(
    frame: Extract<ClientFrame, { t: 'report' }>,
    conn: ConnRecord,
  ): Promise<RoomEffect> {
    const pubkey = conn.pubkey!;

    // Verify signature
    const canonical = canonicalReport({ id: frame.id, ts: frame.ts, target: frame.target });
    const sigOk = await verify(canonical, frame.sig, pubkey);
    if (!sigOk) {
      return makeEffect(conn, { toSender: [err('bad_signature', 'Report signature invalid')] });
    }

    // Timestamp
    const now = this.clock.now();
    if (Math.abs(now - frame.ts) > CLOCK_SKEW_MS) {
      return makeEffect(conn, { toSender: [err('stale_timestamp', 'Timestamp out of range')] });
    }

    const target = await this.store.getMessageById(frame.target);
    if (!target || (target as unknown as { deleted: boolean }).deleted) {
      return makeEffect(conn, { toSender: [err('unknown_target', 'Message not found or already deleted')] });
    }

    // Cannot report own message
    if (target.pubkey === pubkey) {
      return makeEffect(conn, { toSender: [err('forbidden', 'Cannot report your own message')] });
    }

    await this.store.addReport(frame.target, pubkey);
    const count = await this.store.countReporters(frame.target);

    if (count >= REPORT_THRESHOLD) {
      await this.store.markDeleted(frame.target);
      return makeEffect(conn, { toBroadcast: [{ t: 'deleted', id: frame.target }] });
    }

    return makeEffect(conn);
  }

  // -------------------------------------------------------------------------
  // handleAdmin
  // -------------------------------------------------------------------------
  private async handleAdmin(
    frame: AdminFrame,
    conn: ConnRecord,
    allConns: ReadonlyMap<string, ConnRecord>,
  ): Promise<RoomEffect> {
    const pubkey = conn.pubkey!;
    const isMaintainer = this.config.maintainerKeys.includes(pubkey);
    if (!isMaintainer) {
      return makeEffect(conn, { toSender: [err('forbidden', 'Admin access denied')] });
    }

    // Verify signature
    const canonical = canonicalAdmin({ id: frame.id, ts: frame.ts, op: frame.op, arg: frame.arg });
    const sigOk = await verify(canonical, frame.sig, pubkey);
    if (!sigOk) {
      return makeEffect(conn, { toSender: [err('bad_signature', 'Admin signature invalid')] });
    }

    const now = this.clock.now();
    if (Math.abs(now - frame.ts) > CLOCK_SKEW_MS) {
      return makeEffect(conn, { toSender: [err('stale_timestamp', 'Timestamp out of range')] });
    }

    if (frame.op === 'ban') return this.adminBan(frame.arg, conn, allConns);
    if (frame.op === 'unban') return this.adminUnban(frame.arg, conn);
    if (frame.op === 'delete') return this.adminDelete(frame.arg, conn);
    if (frame.op === 'mode') return this.adminMode(frame.arg, conn);

    return makeEffect(conn, { toSender: [err('bad_frame', 'Unknown admin op')] });
  }

  private async adminBan(
    targetKey: string,
    conn: ConnRecord,
    allConns: ReadonlyMap<string, ConnRecord>,
  ): Promise<RoomEffect> {
    if (!/^[0-9a-f]{64}$/.test(targetKey)) {
      return makeEffect(conn, { toSender: [err('bad_frame', 'Invalid pubkey for ban')] });
    }
    // Collect ip hashes of live connections for this key
    const liveConnIds: string[] = [];
    let ipHash = '';
    for (const [cid, c] of allConns) {
      if (c.pubkey === targetKey) {
        liveConnIds.push(cid);
        ipHash = c.ipHash;
      }
    }
    await this.store.addBan(targetKey, ipHash);
    return makeEffect(conn, {
      toClose: liveConnIds,
      toBroadcast: liveConnIds.length > 0
        ? [{ t: 'error', code: 'banned', message: 'You have been banned' }]
        : [],
    });
  }

  private async adminUnban(targetKey: string, conn: ConnRecord): Promise<RoomEffect> {
    if (!/^[0-9a-f]{64}$/.test(targetKey)) {
      return makeEffect(conn, { toSender: [err('bad_frame', 'Invalid pubkey for unban')] });
    }
    await this.store.removeBan(targetKey);
    return makeEffect(conn);
  }

  private async adminDelete(messageId: string, conn: ConnRecord): Promise<RoomEffect> {
    if (!/^[0-9a-f]{32}$/.test(messageId)) {
      return makeEffect(conn, { toSender: [err('bad_frame', 'Invalid message id')] });
    }
    await this.store.markDeleted(messageId);
    return makeEffect(conn, { toBroadcast: [{ t: 'deleted', id: messageId }] });
  }

  private async adminMode(arg: string, conn: ConnRecord): Promise<RoomEffect> {
    if (arg !== 'open' && arg !== 'readonly' && arg !== 'closed') {
      return makeEffect(conn, { toSender: [err('bad_frame', 'Invalid mode')] });
    }
    const mode = arg as RoomMode;
    await this.store.setRoomMode(mode);
    return makeEffect(conn, { toBroadcast: [{ t: 'mode', mode }] });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  private countOnline(
    allConns: ReadonlyMap<string, ConnRecord>,
    includeKey: string | null,
    excludeKey: string | null,
  ): number {
    const keys = new Set<string>();
    for (const c of allConns.values()) {
      if (c.helloOk && c.pubkey) keys.add(c.pubkey);
    }
    if (includeKey) keys.add(includeKey);
    if (excludeKey) keys.delete(excludeKey);
    return keys.size;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (not methods, so they stay under function size limit)
// ---------------------------------------------------------------------------

function countDistinctKeys(conns: ReadonlyMap<string, ConnRecord>): number {
  const keys = new Set<string>();
  for (const c of conns.values()) {
    if (c.helloOk && c.pubkey) keys.add(c.pubkey);
  }
  return keys.size;
}

function countDistinctKeysExcluding(
  conns: ReadonlyMap<string, ConnRecord>,
  excludeKey: string | null,
  excludeConnId: string,
): number {
  const keys = new Set<string>();
  for (const [cid, c] of conns) {
    if (cid === excludeConnId) continue;
    if (c.helloOk && c.pubkey) keys.add(c.pubkey);
  }
  if (excludeKey) keys.delete(excludeKey);
  return keys.size;
}

function countDistinctKeysIncluding(
  conns: ReadonlyMap<string, ConnRecord>,
  includeKey: string,
  _selfConnId: string,
): number {
  const keys = new Set<string>();
  for (const c of conns.values()) {
    if (c.helloOk && c.pubkey) keys.add(c.pubkey);
  }
  keys.add(includeKey);
  return keys.size;
}

function countConnsByIp(
  conns: ReadonlyMap<string, ConnRecord>,
  ipHash: string,
  selfConnId: string,
): number {
  let count = 0;
  for (const [cid, c] of conns) {
    if (cid !== selfConnId && c.ipHash === ipHash) count++;
  }
  return count;
}

export { countDistinctKeys, countDistinctKeysExcluding, countConnsByIp };
export { PRUNE_ON_HELLO_LIMIT };
