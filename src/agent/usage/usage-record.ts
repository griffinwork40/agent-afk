/**
 * Record shapes and pure merge rules for the cross-process usage ledger.
 *
 * A {@link UsageRecord} is everything AFK knows about one provider+credential
 * key: the per-minute admission numbers (RPM / token-per-minute / 429 freeze)
 * and the subscription rolling windows (Anthropic unified 5h / 7d). All times
 * are epoch milliseconds so the record round-trips through JSON unchanged.
 *
 * Invariant: merging is monotone in observation time. Each section is replaced
 * only by an observation whose `observedAt` is >= the stored one, so an older
 * observation published late (a slow process, a throttled trailing flush) can
 * never overwrite a newer one. The single exception is `frozenUntil`, which
 * merges by MAX regardless of section age: a 429 freeze is a fact about the
 * server's future, not a reading that ages, and every process must honour the
 * longest one any process has seen.
 *
 * Pure module: no I/O, no module state. The ledger (`usage-ledger.ts`) and the
 * snapshot reader (`usage-snapshot.ts`) both build on these functions.
 *
 * @module agent/usage/usage-record
 */

/** Per-minute admission numbers as last reported by the server. */
export interface PerMinuteObservation {
  requestsRemaining?: number;
  requestsLimit?: number;
  /** Epoch ms when the request window resets. */
  requestsResetAt?: number;
  /** Input tokens (Anthropic) or combined tokens (OpenAI) remaining this minute. */
  tokensRemaining?: number;
  tokensLimit?: number;
  /** Epoch ms when the token window resets. */
  tokensResetAt?: number;
  /** Epoch ms until which a 429 forbids new requests. */
  frozenUntil?: number;
  /** Epoch ms the counts were read from a response. */
  observedAt: number;
}

/** One rolling subscription window. */
export interface WindowObservation {
  /** Fraction of the window consumed, 0..1. */
  utilization: number;
  /** Epoch ms when the window resets, when reported. */
  resetsAt?: number;
}

/**
 * One entry in the per-window observation history ring.
 * Stored inside {@link WindowsObservation.history} — a bounded ring of recent
 * snapshots used by the burn-rate projector (`burn-rate.ts`). Absent on records
 * written by older AFK versions; the projector treats missing history as "no
 * projection".
 */
export interface WindowHistorySample {
  readonly observedAt: number;
  readonly utilization: number;
  readonly resetsAt?: number;
}

/** Subscription windows (Anthropic OAuth unified 5h / 7d headers, or the OAuth usage endpoint). */
export interface WindowsObservation {
  fiveHour?: WindowObservation;
  sevenDay?: WindowObservation;
  /** Model-scoped 7d windows; only the OAuth usage endpoint reports these. */
  sevenDaySonnet?: WindowObservation;
  sevenDayOpus?: WindowObservation;
  observedAt: number;
  /**
   * Bounded ring of recent binding-window snapshots (oldest-first), used by
   * the burn-rate projector. Only present on records written by AFK versions
   * that support burn-rate projection. Absent = no projection.
   */
  history?: WindowHistorySample[];
}

/** Every window key, in display order. The single source for window iteration. */
export const WINDOW_KEYS = ['fiveHour', 'sevenDay', 'sevenDaySonnet', 'sevenDayOpus'] as const;
export type WindowKey = (typeof WINDOW_KEYS)[number];

/** Short human label per window — shared by the CLI, runtime state, notice, and daemon gate. */
export const WINDOW_LABELS: Readonly<Record<WindowKey, string>> = {
  fiveHour: '5h',
  sevenDay: '7d',
  sevenDaySonnet: '7d-sonnet',
  sevenDayOpus: '7d-opus',
};

/**
 * An observation older than this is `stale`. Re-exported by the status line
 * (`cli/quota-indicator.ts` STALE_AFTER_MS) so every usage surface ages a
 * reading identically.
 */
export const USAGE_STALE_AFTER_MS = 10 * 60 * 1000;

/** Ledger document key for one provider+account (matches the StateStore key pattern). */
export function usageKey(provider: string, account: string): string {
  return `${provider}.${account}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}

/** Everything known about one provider+credential key. */
export interface UsageRecord {
  /** Schema version of the stored document. */
  v: 1;
  provider: string;
  account: string;
  perMinute?: PerMinuteObservation;
  windows?: WindowsObservation;
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/** Merge two per-minute observations: newer counts win, freeze merges by MAX. */
export function mergePerMinute(
  a: PerMinuteObservation | undefined,
  b: PerMinuteObservation | undefined,
): PerMinuteObservation | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const newer = b.observedAt >= a.observedAt ? b : a;
  const frozenUntil = maxDefined(a.frozenUntil, b.frozenUntil);
  const { frozenUntil: _drop, ...rest } = newer;
  void _drop;
  return { ...rest, ...(frozenUntil !== undefined ? { frozenUntil } : {}) };
}

/**
 * Merge two window history rings: concatenate, deduplicate by observedAt,
 * sort oldest-first, and trim to the newest {@link WINDOWS_HISTORY_MAX} entries.
 * Exported so tests can call it directly.
 */
export const WINDOWS_HISTORY_MAX = 12;

export function mergeWindowHistory(
  a: WindowHistorySample[] | undefined,
  b: WindowHistorySample[] | undefined,
): WindowHistorySample[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  const all = [...(a ?? []), ...(b ?? [])];
  const byTime = new Map<number, WindowHistorySample>();
  for (const s of all) byTime.set(s.observedAt, s);
  const sorted = [...byTime.values()].sort((x, y) => x.observedAt - y.observedAt);
  const trimmed = sorted.length > WINDOWS_HISTORY_MAX
    ? sorted.slice(sorted.length - WINDOWS_HISTORY_MAX)
    : sorted;
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Merge two window observations: the newer reading wins whole; histories are unioned. */
export function mergeWindows(
  a: WindowsObservation | undefined,
  b: WindowsObservation | undefined,
): WindowsObservation | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const winner = b.observedAt >= a.observedAt ? b : a;
  const history = mergeWindowHistory(a.history, b.history);
  return history !== undefined ? { ...winner, history } : winner;
}

/**
 * Merge `incoming` into `existing` (see the module Invariant). Identity fields
 * come from `incoming` when present. Pure; neither argument is mutated.
 */
export function mergeUsageRecords(
  existing: UsageRecord | undefined,
  incoming: UsageRecord,
): UsageRecord {
  if (existing === undefined) return incoming;
  const perMinute = mergePerMinute(existing.perMinute, incoming.perMinute);
  const windows = mergeWindows(existing.windows, incoming.windows);
  return {
    v: 1,
    provider: incoming.provider,
    account: incoming.account,
    ...(perMinute !== undefined ? { perMinute } : {}),
    ...(windows !== undefined ? { windows } : {}),
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Narrow an untrusted JSON value (read from the shared store, possibly written
 * by a different AFK version) to a {@link UsageRecord}, or `undefined` when it
 * does not have the expected shape. Never throws.
 */
export function parseUsageRecord(raw: unknown): UsageRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1 || typeof r['provider'] !== 'string' || typeof r['account'] !== 'string') {
    return undefined;
  }
  const out: UsageRecord = { v: 1, provider: r['provider'], account: r['account'] };
  const pm = r['perMinute'] as Record<string, unknown> | undefined;
  if (pm && typeof pm === 'object' && isFiniteNumber(pm['observedAt'])) {
    const p: PerMinuteObservation = { observedAt: pm['observedAt'] };
    for (const f of [
      'requestsRemaining', 'requestsLimit', 'requestsResetAt',
      'tokensRemaining', 'tokensLimit', 'tokensResetAt', 'frozenUntil',
    ] as const) {
      const val = pm[f];
      if (isFiniteNumber(val)) p[f] = val;
    }
    out.perMinute = p;
  }
  const w = r['windows'] as Record<string, unknown> | undefined;
  if (w && typeof w === 'object' && isFiniteNumber(w['observedAt'])) {
    const win: WindowsObservation = { observedAt: w['observedAt'] };
    for (const f of WINDOW_KEYS) {
      const src = w[f] as Record<string, unknown> | undefined;
      if (src && typeof src === 'object' && isFiniteNumber(src['utilization'])) {
        const resetsAt = src['resetsAt'];
        win[f] = {
          utilization: Math.min(1, Math.max(0, src['utilization'])),
          ...(isFiniteNumber(resetsAt) ? { resetsAt } : {}),
        };
      }
    }
    // Parse bounded history ring; silently drop malformed entries.
    // Cap the raw array before iterating so an oversized payload cannot cause
    // unbounded work — only the newest WINDOWS_HISTORY_MAX entries can matter.
    const rawHistory = w['history'];
    if (Array.isArray(rawHistory)) {
      const cappedHistory = rawHistory.length > WINDOWS_HISTORY_MAX
        ? rawHistory.slice(rawHistory.length - WINDOWS_HISTORY_MAX)
        : rawHistory;
      const parsed: WindowHistorySample[] = [];
      for (const entry of cappedHistory) {
        if (entry && typeof entry === 'object') {
          const e = entry as Record<string, unknown>;
          if (isFiniteNumber(e['observedAt']) && isFiniteNumber(e['utilization'])) {
            const s: WindowHistorySample = {
              observedAt: e['observedAt'],
              utilization: Math.min(1, Math.max(0, e['utilization'])),
              ...(isFiniteNumber(e['resetsAt']) ? { resetsAt: e['resetsAt'] } : {}),
            };
            parsed.push(s);
          }
        }
      }
      if (parsed.length > 0) win.history = parsed;
    }
    out.windows = win;
  }
  return out;
}
