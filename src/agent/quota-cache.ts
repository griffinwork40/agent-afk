/**
 * Passive module-scope cache for Anthropic's OAuth-subscription quota headers.
 *
 * Every response returned to a Claude subscription (OAuth) caller carries
 * `anthropic-ratelimit-unified-5h-*` / `-7d-*` headers describing how much of
 * the rolling 5-hour and 7-day windows have been consumed. These headers cost
 * nothing extra to read — they ride on responses the SDK already made — so
 * this module captures them passively from the tracing-fetch wrapper
 * (`providers/anthropic-direct/tracing-fetch.ts`) and holds the latest snapshot
 * for the CLI status line to poll or subscribe to.
 *
 * The headers are UNDOCUMENTED and have been observed to change names
 * upstream, so every parse in this module is best-effort: a missing, renamed,
 * or unparseable header is silently omitted, never thrown.
 *
 * @module agent/quota-cache
 */

/** Fraction-of-window ceiling: clamp any reported utilization into `0..1`. */
function parseUtilization(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

/**
 * Reject anything past this instant (2100-01-01T00:00:00Z) as an "absurd"
 * reset timestamp — almost certainly a unit mismatch (ms vs. s) rather than a
 * real reset deadline this far out.
 */
const MAX_REASONABLE_RESET_EPOCH_SECONDS = Date.UTC(2100, 0, 1) / 1000;

/** Epoch-seconds → `Date`, or `undefined` when the value isn't a sane forward deadline. */
function parseResetEpochSeconds(raw: string | null): Date | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_REASONABLE_RESET_EPOCH_SECONDS) return undefined;
  return new Date(n * 1000);
}

export interface QuotaSnapshot {
  /** Fraction of the 5-hour rolling window consumed, 0..1. */
  readonly fiveHourUtilization?: number;
  readonly fiveHourResetsAt?: Date;
  /** Fraction of the 7-day window consumed, 0..1. */
  readonly sevenDayUtilization?: number;
  readonly sevenDayResetsAt?: Date;
  readonly observedAt: Date;
}

/**
 * Pure. Reads the four `anthropic-ratelimit-unified-*` headers (case-
 * insensitive via `headers.get`) and returns a snapshot, or `undefined` when
 * neither window's utilization is present/parseable — i.e. nothing worth
 * caching. Never throws: an individual malformed field is simply omitted
 * rather than failing the whole parse.
 */
export function parseQuotaHeaders(headers: Headers): QuotaSnapshot | undefined {
  try {
    const fiveHourUtilization = parseUtilization(
      headers.get('anthropic-ratelimit-unified-5h-utilization'),
    );
    const fiveHourResetsAt = parseResetEpochSeconds(
      headers.get('anthropic-ratelimit-unified-5h-reset'),
    );
    const sevenDayUtilization = parseUtilization(
      headers.get('anthropic-ratelimit-unified-7d-utilization'),
    );
    const sevenDayResetsAt = parseResetEpochSeconds(
      headers.get('anthropic-ratelimit-unified-7d-reset'),
    );
    if (fiveHourUtilization === undefined && sevenDayUtilization === undefined) return undefined;
    return {
      ...(fiveHourUtilization !== undefined ? { fiveHourUtilization } : {}),
      ...(fiveHourResetsAt !== undefined ? { fiveHourResetsAt } : {}),
      ...(sevenDayUtilization !== undefined ? { sevenDayUtilization } : {}),
      ...(sevenDayResetsAt !== undefined ? { sevenDayResetsAt } : {}),
      observedAt: new Date(),
    };
  } catch {
    // Best-effort: a header read/parse must never throw or block the request
    // that carried it.
    return undefined;
  }
}

// Invariant: this cache is module-scope mutable state, valid for exactly one
// Node process. AFK runs one CLI/daemon/Telegram process per session with no
// cross-process sharing, so a single "latest snapshot" + listener set here is
// sufficient — there is no multi-process fan-in to reconcile. Tests must call
// `resetQuotaCacheForTests()` between cases (same-file vitest tests share this
// module instance) to avoid state leaking across assertions.
let currentSnapshot: QuotaSnapshot | undefined;
const listeners = new Set<() => void>();

/** `Math.round(utilization * 100)`, or `undefined` when the window is absent. */
function roundedPercent(utilization: number | undefined): number | undefined {
  return utilization === undefined ? undefined : Math.round(utilization * 100);
}

/**
 * Store a snapshot; notify listeners ONLY when a rounded percentage changed
 * for either window (or when this is the first snapshot ever recorded).
 *
 * Flicker requirement: the consumer's repaint throttles at 100ms and stores-
 * without-painting with no trailing flush, so a push on every single API
 * response would churn the bottom terminal row. Gating notification on the
 * rounded percentage keeps updates meaningful to a human glance while still
 * always keeping the stored snapshot current for the next poll.
 */
export function recordQuotaSnapshot(snapshot: QuotaSnapshot): void {
  const previous = currentSnapshot;
  const meaningfulChange =
    previous === undefined ||
    roundedPercent(previous.fiveHourUtilization) !== roundedPercent(snapshot.fiveHourUtilization) ||
    roundedPercent(previous.sevenDayUtilization) !== roundedPercent(snapshot.sevenDayUtilization);
  currentSnapshot = snapshot;
  if (!meaningfulChange) return;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must never break the fetch/caller that recorded
      // this snapshot.
    }
  }
}

/** Latest snapshot, or `undefined` if none seen this process. */
export function getQuotaSnapshot(): QuotaSnapshot | undefined {
  return currentSnapshot;
}

/** Subscribe to meaningful changes (see {@link recordQuotaSnapshot}). Returns an unsubscribe fn. */
export function onQuotaUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: clear cache + listeners. */
export function resetQuotaCacheForTests(): void {
  currentSnapshot = undefined;
  listeners.clear();
}
