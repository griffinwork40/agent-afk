/**
 * Pure, clock-injectable guard logic for peer messaging.
 *
 * All state management is stateless from the module perspective — guards that
 * require historical data (rate limiting, duplicate detection) scan the
 * filesystem rather than keeping in-memory singletons, making them safe
 * across process restarts and concurrent REPL sessions.
 *
 * Contract:
 *   - `checkSendGuards` is pure given its inputs plus the filesystem state
 *     under the inbox dirs. It never writes; only reads.
 *   - `createWakeBudget` returns a per-instance stateful budget object. The
 *     instance is owned by the receiver loop and is NOT module-global state.
 *   - All clock-dependent logic accepts an injectable `now` parameter
 *     (defaults to `Date.now`) for deterministic testing.
 *
 * @module agent/peer/guards
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { parseEnvelope, PEER_MAX_BODY_BYTES, PEER_MAX_HOPS } from './envelope.js';
import { getPeerInboxDir } from '../../paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All refusal reasons the guard layer may return. */
export type PeerRefusal =
  | 'self'
  | 'dead-target'
  | 'ambiguous-target'
  | 'unknown-target'
  | 'no-receiver'
  | 'too-large'
  | 'hop-limit'
  | 'rate-limited'
  | 'duplicate'
  | 'inbound-off';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max messages per sender→target pair per minute. */
const RATE_LIMIT_PER_MIN = 10;
const RATE_WINDOW_MS = 60_000;

/** Duplicate-drop window: same sender+target+body hash within 60 seconds. */
const DEDUP_WINDOW_MS = 60_000;

/**
 * Duration of the wake-budget window. Exported so `inbox-retention.ts` can
 * derive the delivered-receipt retention threshold from the same constant
 * rather than hardcoding a separate magic number.
 */
export const PEER_WAKE_BUDGET_WINDOW_MS = 3_600_000; // 1 hour

// ---------------------------------------------------------------------------
// Sender-side: rate limit and duplicate detection via inbox scan
// ---------------------------------------------------------------------------

/**
 * SHA-256 of the body text — used for duplicate detection.
 * Only the first 16 hex chars are compared (collision risk negligible for this
 * use-case: same body, same sender, same target, within 60s).
 */
function bodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Parse the timestamp prefix from a sortable inbox filename.
 * Format: `<ISO-ts-sortable>-<messageId>.json` where the ts portion is
 * the result of `toISOString().replace(/[:.]/g, '-')`.
 * Returns the numeric timestamp or 0 on parse failure.
 */
function tsFromFilename(filename: string): number {
  // e.g. "2026-10-02T12-30-45-123Z-<uuid>.json"
  const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!match || !match[1]) return 0;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read all envelope files from a single inbox sub-directory (pending,
 * delivered, or held) for the target, filtering by sender and time window.
 * Returns matching parsed envelopes. Best-effort: any unreadable file is
 * skipped silently.
 */
async function scanInboxDir(
  targetId: string,
  subdir: 'pending' | 'delivered' | 'held',
  senderId: string,
  windowMs: number,
  now: () => number,
): Promise<{ messageId: string; ts: number; bodyHash: string }[]> {
  const dir = join(getPeerInboxDir(targetId), subdir);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const cutoff = now() - windowMs;
  const results: { messageId: string; ts: number; bodyHash: string }[] = [];
  for (const file of files) {
    if (file.startsWith('.tmp-')) continue;
    const ts = tsFromFilename(file);
    if (ts < cutoff) continue;
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      const env = parseEnvelope(raw);
      if (env && env.from.id === senderId) {
        results.push({ messageId: env.messageId, ts, bodyHash: bodyHash(env.body) });
      }
    } catch {
      // Skip unreadable / partially-written files silently.
    }
  }
  return results;
}

/** Options for `checkSendGuards`. */
export interface CheckSendGuardsOpts {
  senderId: string;
  targetId: string;
  body: string;
  hop: number;
  now?: () => number;
}

/**
 * Check sender-side guards: body size, hop limit, rate limit, duplicate.
 *
 * Returns `null` if all checks pass, or the {@link PeerRefusal} code that
 * fired first.
 *
 * Scanning the target's `pending/`, `delivered/`, and `held/` directories is the chosen
 * approach (cross-process correct; no sender-side state file needed).
 */
export async function checkSendGuards(opts: CheckSendGuardsOpts): Promise<PeerRefusal | null> {
  const { senderId, targetId, body, hop, now: getNow = Date.now } = opts;

  if (Buffer.byteLength(body, 'utf8') > PEER_MAX_BODY_BYTES) return 'too-large';
  if (hop > PEER_MAX_HOPS) return 'hop-limit';

  // Scan pending, delivered, AND held to build history for rate/dedup checks.
  // Held envelopes (inbound-mode=hold or wake-budget exhausted) must be
  // counted to prevent a sender from bypassing rate limiting or duplicate
  // detection by inducing enough held messages to obscure their send history.
  const window = Math.max(RATE_WINDOW_MS, DEDUP_WINDOW_MS);
  const [pendingHistory, deliveredHistory, heldHistory] = await Promise.all([
    scanInboxDir(targetId, 'pending', senderId, window, getNow),
    scanInboxDir(targetId, 'delivered', senderId, window, getNow),
    scanInboxDir(targetId, 'held', senderId, window, getNow),
  ]);
  const history = [...pendingHistory, ...deliveredHistory, ...heldHistory];

  const nowMs = getNow();
  const rateCutoff = nowMs - RATE_WINDOW_MS;
  const dedupCutoff = nowMs - DEDUP_WINDOW_MS;
  const bHash = bodyHash(body);

  let rateCount = 0;
  const seen = new Set<string>();
  for (const entry of history) {
    // A receipt and crash-leftover source represent one envelope, not two sends.
    if (seen.has(entry.messageId)) continue;
    seen.add(entry.messageId);
    if (entry.ts >= rateCutoff) rateCount++;
    if (entry.ts >= dedupCutoff && entry.bodyHash === bHash) return 'duplicate';
  }
  if (rateCount >= RATE_LIMIT_PER_MIN) return 'rate-limited';

  return null;
}

// ---------------------------------------------------------------------------
// Receiver-side: wake budget
// ---------------------------------------------------------------------------

/** Options for `createWakeBudget`. */
export interface WakeBudgetOpts {
  /** Max wakes per sender per hour. Default 20. */
  perSenderPerHour?: number;
  /** Injected clock for testing. */
  now?: () => number;
}

/** Per-session wake budget — tracks per-sender wake counts within the hour. */
export interface WakeBudget {
  /**
   * Attempt to consume one wake credit for `senderId`. Returns `true` when the
   * budget has remaining capacity, `false` when the limit has been reached.
   * Expired entries (> 1 hour old) are pruned before checking.
   *
   * Callers must call `refund(senderId)` if the consuming action ultimately
   * did not succeed (e.g. the claim returned null due to a lost race). This
   * keeps the budget accurate: only actions that actually wake the session
   * consume a permanent slot.
   */
  tryConsume(senderId: string): boolean;
  /**
   * Return the most recently recorded wake credit for `senderId`. Call when
   * `tryConsume` returned `true` but the subsequent action did not complete
   * (e.g. `claimPending` returned `null`). Safe to call after `tryConsume`
   * returned `false` — it is a no-op in that case.
   */
  refund(senderId: string): void;
}

/**
 * Create a receiver-side wake budget object. The returned instance is stateful
 * (in-memory, per-process) and is intended to be owned by a single receiver
 * loop — it is NOT a module singleton.
 *
 * Default: 20 wakes per sender per hour.
 */
export function createWakeBudget(opts?: WakeBudgetOpts): WakeBudget {
  const limit = opts?.perSenderPerHour ?? 20;
  const getNow = opts?.now ?? Date.now;

  // Map<senderId, timestamps[]> — each entry is the time a wake was granted.
  const slots = new Map<string, number[]>();

  return {
    tryConsume(senderId: string): boolean {
      const nowMs = getNow();
      const cutoff = nowMs - PEER_WAKE_BUDGET_WINDOW_MS;
      const prev = (slots.get(senderId) ?? []).filter((t) => t >= cutoff);
      if (prev.length >= limit) {
        slots.set(senderId, prev);
        return false;
      }
      prev.push(nowMs);
      slots.set(senderId, prev);
      return true;
    },
    refund(senderId: string): void {
      const existing = slots.get(senderId);
      if (!existing || existing.length === 0) return;
      // Remove the most recently added timestamp for this sender.
      existing.pop();
      slots.set(senderId, existing);
    },
  };
}
