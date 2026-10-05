/**
 * Cross-process usage ledger: one {@link UsageRecord} per provider+account,
 * persisted in the shared SQLite state store (`state/kv/kv.db`, namespace
 * `usage`) so every AFK process on the machine — REPL panes, the daemon, the
 * Telegram bot, `afk usage` — sees the same rate-limit / quota picture.
 *
 * Writers: the provider fetch observers (`publishUsage`) on every response
 * that carries rate-limit headers, plus the OAuth usage endpoint when a reader
 * refreshes it. Readers: `usage-snapshot.ts` (all records) and the admission
 * bucket registry (`readLedgerRecord`, one key, throttled by the bucket) so a
 * peer's 429 freeze backs off every process on the same provider+account.
 *
 * Invariant: writes are a lossless read-modify-write. `publishUsage` reads the
 * current row, merges with the monotone rules in `usage-record.ts`, and
 * commits through `StateStore.cas` (or `insertIfAbsent` for the first write),
 * retrying on a lost race. A slow process publishing an older observation can
 * therefore never clobber a newer one from another process — the failure mode
 * that ruled out a plain shared JSON file.
 *
 * Invariant: the ledger is observability, never a dependency. Every entry
 * point swallows its own errors and a store that fails to open disables the
 * ledger for the rest of the process. `AFK_USAGE_LEDGER_DISABLED=1` turns it
 * off entirely; readers then fall back to the in-process quota cache.
 *
 * @module agent/usage/usage-ledger
 */

import { existsSync } from 'node:fs';
import { StateStore } from '../state/state-store.js';
import { getStateDatabasePath } from '../../paths.js';
import { env } from '../../config/env.js';
import {
  mergeUsageRecords,
  parseUsageRecord,
  usageKey,
  WINDOW_KEYS,
  type PerMinuteObservation,
  type UsageRecord,
  type WindowHistorySample,
  type WindowsObservation,
} from './usage-record.js';
import { appendSample } from './burn-rate.js';
import type { QuotaSnapshot } from '../quota-cache.js';
import type { RateLimitSnapshot } from '../providers/shared/rate-limit-bucket.js';
import type { RateLimitGate } from '../providers/shared/tracing-fetch-utils.js';
import type { UsageResult } from '../subscription-usage.js';

const NAMESPACE = 'usage';
const MAX_CAS_ATTEMPTS = 4;

/**
 * Build a history sample from the binding (highest-utilization) window in a
 * `WindowsObservation`. Returns `undefined` when no window is present.
 * Exported for tests.
 */
export function bindingSampleFromWindows(w: WindowsObservation): WindowHistorySample | undefined {
  let best: WindowHistorySample | undefined;
  for (const key of WINDOW_KEYS) {
    const win = w[key];
    if (win === undefined) continue;
    if (best === undefined || win.utilization > best.utilization) {
      best = {
        observedAt: w.observedAt,
        utilization: win.utilization,
        ...(win.resetsAt !== undefined ? { resetsAt: win.resetsAt } : {}),
      };
    }
  }
  return best;
}

/**
 * Enrich an incoming `WindowsObservation` with the new sample appended to the
 * existing history ring. Carries the existing ring forward even when the
 * incoming record has none.
 */
function withHistorySample(
  incoming: WindowsObservation,
  existing: WindowsObservation | undefined,
): WindowsObservation {
  const sample = bindingSampleFromWindows(incoming);
  if (sample === undefined) return incoming;
  const base = existing?.history ?? [];
  const history = appendSample(base, sample);
  return { ...incoming, history };
}
/** Minimum spacing between unchanged publishes for one key (freezes bypass it). */
const PUBLISH_MIN_INTERVAL_MS = 5_000;
/** Mirrors the bucket's own clamp so the ledger never advertises a longer freeze. */
const FREEZE_MAX_MS = 120_000;

// Invariant: process-local handle + publish throttle. The ledger DATA is
// cross-process (SQLite); only the connection and the "when did THIS process
// last write key K" bookkeeping live here. The handle is keyed by DB path so a
// state-dir change (tests re-pointing AFK_HOME) reopens rather than writing to
// a stale file; `db: null` = open failed for that path, stay off.
let store: { path: string; db: StateStore | null } | undefined;
const lastPublish = new Map<string, { at: number; sig: string }>();

// Invariant: readers never CREATE or hold the database. `forRead` returns null
// (without caching) when no store file exists yet, so a process that only
// reads usage opens no SQLite file: nothing to lock on Windows, nothing
// created as a side effect of `afk usage` or a fan-out notice. Only a publish
// creates the file.
function ledgerStore(forRead = false): StateStore | null {
  if (env.AFK_USAGE_LEDGER_DISABLED === '1') return null;
  const path = getStateDatabasePath();
  if (store?.path === path) return store.db;
  if (forRead && !existsSync(path)) return null;
  closeStore();
  let db: StateStore | null;
  try {
    db = new StateStore(path);
  } catch {
    db = null;
  }
  store = { path, db };
  return db;
}

function closeStore(): void {
  try {
    store?.db?.close();
  } catch {
    // best-effort
  }
  store = undefined;
}

/** Test-only: close the connection and forget throttle state. */
export function resetUsageLedgerForTests(): void {
  closeStore();
  lastPublish.clear();
}

function signature(rec: UsageRecord): string {
  const w = rec.windows;
  const pm = rec.perMinute;
  return JSON.stringify([
    w && WINDOW_KEYS.map((k) => {
      const x = w[k];
      return x === undefined ? null : Math.round(x.utilization * 100);
    }),
    pm && [pm.requestsRemaining, pm.tokensRemaining],
  ]);
}

// Invariant: throttled is a pure read — it never mutates lastPublish.
// publishUsage records lastPublish only after writeMerged reports success,
// so a CAS-exhausted write does not suppress the next attempt within the throttle window.
function throttled(key: string, rec: UsageRecord, now: number): boolean {
  if (rec.perMinute?.frozenUntil !== undefined) return false;
  const sig = signature(rec);
  const prev = lastPublish.get(key);
  return prev !== undefined && prev.sig === sig && now - prev.at < PUBLISH_MIN_INTERVAL_MS;
}

// Returns true when the write landed (insert or CAS succeeded); false when all
// CAS attempts were exhausted and the record was NOT committed.
function writeMerged(db: StateStore, key: string, rec: UsageRecord): boolean {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = db.get(NAMESPACE, key);
    if (row === null) {
      // First write: seed history from this record's own windows.
      const seeded = rec.windows !== undefined
        ? { ...rec, windows: withHistorySample(rec.windows, undefined) }
        : rec;
      if (db.insertIfAbsent(NAMESPACE, key, seeded).created) return true;
      continue;
    }
    const existing = parseUsageRecord(row.value);
    // Enrich incoming windows with a history sample before merging, carrying
    // the existing ring forward so no samples are lost on a concurrent write.
    const enriched = rec.windows !== undefined
      ? { ...rec, windows: withHistorySample(rec.windows, existing?.windows) }
      : rec;
    const merged = mergeUsageRecords(existing, enriched);
    if (db.cas(NAMESPACE, key, row.version, merged).matched) return true;
  }
  return false;
}

/**
 * Merge one observation into the shared ledger. Never throws; throttled so a
 * burst of identical responses costs one write per {@link PUBLISH_MIN_INTERVAL_MS}.
 */
export function publishUsage(rec: UsageRecord, now: number = Date.now()): void {
  try {
    const db = ledgerStore();
    if (db === null) return;
    const key = usageKey(rec.provider, rec.account);
    if (throttled(key, rec, now)) return;
    if (writeMerged(db, key, rec)) {
      lastPublish.set(key, { at: now, sig: signature(rec) });
    }
  } catch {
    // Observability only — a ledger failure must never touch the request path.
  }
}

/** Every parseable record in the ledger. Never throws; `[]` when unavailable. */
export function readLedgerRecords(): UsageRecord[] {
  try {
    const db = ledgerStore(true);
    if (db === null) return [];
    return db
      .query(NAMESPACE, { limit: 100 })
      .map((r) => parseUsageRecord(r.value))
      .filter((r): r is UsageRecord => r !== undefined);
  } catch {
    return [];
  }
}

/**
 * The record for one provider+account, or undefined. Never throws. A single
 * primary-key read on the shared connection; callers on the request path
 * (the admission bucket) throttle it themselves.
 */
export function readLedgerRecord(provider: string, account: string): UsageRecord | undefined {
  try {
    const db = ledgerStore(true);
    if (db === null) return undefined;
    const row = db.get(NAMESPACE, usageKey(provider, account));
    return row === null ? undefined : parseUsageRecord(row.value);
  } catch {
    return undefined;
  }
}

// ── Observation adapters (one per source) ────────────────────────────────────

/** Anthropic unified-header snapshot (quota cache shape) → windows observation. */
export function windowsFromQuotaSnapshot(s: QuotaSnapshot): WindowsObservation {
  const win = (u: number | undefined, r: Date | undefined) =>
    u === undefined ? undefined : { utilization: u, ...(r ? { resetsAt: r.getTime() } : {}) };
  const fiveHour = win(s.fiveHourUtilization, s.fiveHourResetsAt);
  const sevenDay = win(s.sevenDayUtilization, s.sevenDayResetsAt);
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    observedAt: s.observedAt.getTime(),
  };
}

/** OAuth usage-endpoint result → windows observation, or undefined when unavailable. */
export function windowsFromUsageResult(r: UsageResult, now: number): WindowsObservation | undefined {
  if (r.kind !== 'ok') return undefined;
  const out: WindowsObservation = { observedAt: now };
  for (const k of WINDOW_KEYS) {
    const w = r[k];
    if (w) out[k] = { utilization: w.utilization, ...(w.resetsAt ? { resetsAt: w.resetsAt.getTime() } : {}) };
  }
  return out;
}

/** Per-minute header snapshot (bucket shape) → per-minute observation. */
export function perMinuteFromRateLimit(s: RateLimitSnapshot, now: number): PerMinuteObservation {
  const out: PerMinuteObservation = { observedAt: now };
  if (s.requestsRemaining !== undefined) out.requestsRemaining = s.requestsRemaining;
  if (s.requestsLimit !== undefined) out.requestsLimit = s.requestsLimit;
  if (s.requestsResetAt !== undefined) out.requestsResetAt = s.requestsResetAt;
  if (s.inputTokensRemaining !== undefined) out.tokensRemaining = s.inputTokensRemaining;
  if (s.inputTokensLimit !== undefined) out.tokensLimit = s.inputTokensLimit;
  if (s.inputTokensResetAt !== undefined) out.tokensResetAt = s.inputTokensResetAt;
  return out;
}

/**
 * Decorate an admission gate so every 429 freeze is also published to the
 * ledger. Other processes see it in `afk usage` / `get_runtime_state`, and
 * their per-key admission buckets (`rate-limit-bucket.registry.ts`) adopt it
 * on their next throttled peer read and back off too.
 */
export function publishingGate(gate: RateLimitGate, provider: string, account: string): RateLimitGate {
  return {
    acquirePermit: (tokens, signal) => gate.acquirePermit(tokens, signal),
    freeze(retryAfterMs: number): void {
      gate.freeze(retryAfterMs);
      const now = Date.now();
      publishUsage({
        v: 1, provider, account,
        perMinute: { frozenUntil: now + Math.min(retryAfterMs, FREEZE_MAX_MS), observedAt: now },
      }, now);
    },
  };
}
