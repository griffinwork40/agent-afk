/**
 * Usage/quota limit detection and wait-out logic for the openai-compatible
 * provider. Implements feature parity with anthropic-direct's
 * `usage-limit-tier.ts` + `usage-limit-pause.ts` for the 429 quota/billing
 * limit case — issue #2418.
 *
 * # Classification
 *
 * Two signals mark a quota/usage limit:
 *
 *   1. The ChatGPT/Codex subscription backend's `usage_limit_reached` body
 *      (see `chatgpt-usage-limit.ts`). Authoritative: it carries the real
 *      reset time (`resets_at` / `resets_in_seconds`) and no `retry-after`.
 *      It may arrive with or without an HTTP status (mid-stream SSE error).
 *
 *   2. Otherwise, MAGNITUDE of a standard `retry-after` / `retry-after-ms`
 *      header on a 429 (the same fallback the Anthropic path uses when no
 *      authoritative headers are present, per usage-limit.ts step 4):
 *        retry-after ≤ QUOTA_TRANSIENT_THRESHOLD_MS (5 min) → transient
 *          → the retry path handles it (retry.ts / stream-drive.connection.ts)
 *        retry-after > QUOTA_TRANSIENT_THRESHOLD_MS → quota/usage-limit
 *          → THIS module parks and waits out the reset.
 *        no retry-after → transient (left to the bounded connection retry).
 *
 * # Behavior
 *
 *   autoResumeOnUsageLimit (default true):
 *     1. Yield `paused` with `reason: 'usage-limit'`, `autoResume: true`.
 *     2. Sleep until the ChatGPT reset time, else `retry-after` ms (or
 *        QUOTA_FALLBACK_WAIT_MS when absent), bounded by TWO_HOURS_MS. The
 *        sleep is abort-signal-aware. A ChatGPT reset more than TWO_HOURS_MS
 *        away is not waited on: `paused` is emitted, then the error surfaces.
 *     3. On wake: emit `resumed`, replay the iteration.
 *     4. If the limit is still in place (another quota 429 arrives): loop,
 *        staying in paused state, until abort or TWO_HOURS_MS total elapsed.
 *
 *   autoResumeOnUsageLimit = false:
 *     Yield `paused` with `autoResume: false`, then yield the `error` event
 *     without replaying — mirrors the anthropic-direct fail-fast path.
 *
 * # Layering
 *
 * This tier wraps `runIterationWithOverloadPause` in `turn-driver.ts` — the
 * same call site the overload-pause-tier wraps its iteration. The pattern is:
 *
 *   usage-limit tier (outer)
 *     └── overload-pause tier (inner)
 *           └── runIteration / driveStream
 *
 * The outer tier catches `error` events with a quota-429 status ONLY; all
 * other events (including overload 529/503) pass through transparently to the
 * caller. The `error` event captured here is the one driveStream surfaces when
 * the connection-phase retry budget is exhausted — i.e. after all transient
 * short retries have been spent, the first long-retry-after 429 remains.
 *
 * @module agent/providers/openai-compatible/query/usage-limit-tier
 */

import type { ProviderEvent } from '../../../provider.js';
import type { TraceSink } from '../../../trace/index.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import { parseRetryAfterMs } from '../../shared/retry-after.js';
import { getErrorStatus } from './retry.js';
import type { IterationResult } from './stream-drive.js';
import { classifyChatGptUsageLimit, isChatGptUsageLimitError } from './chatgpt-usage-limit.js';
import type { ChatGptUsageLimitInfo } from './chatgpt-usage-limit.js';

/**
 * Same magnitude threshold as `anthropic-direct/usage-limit.ts`
 * `RATE_LIMIT_TRANSIENT_MAX_RETRY_AFTER_MS` — the dividing line between a
 * short transient rate-limit (handled by the retry path) and a long quota /
 * billing limit (handled here with a full pause+resume cycle).
 *
 * 5 minutes: per-minute API throttle windows clear in ≤ a minute or two, so
 * any `retry-after` above this line is almost certainly a subscription cap or
 * billing hold, not a per-minute token bucket refill.
 */
export const QUOTA_TRANSIENT_THRESHOLD_MS = 5 * 60 * 1000;

/** Test injection: override the quota-vs-transient threshold for fake-timer tests. */
let quotaThresholdOverride: number | null = null;
/** @internal Test injection for the transient/quota threshold. Pass null to restore production default. */
export function __setQuotaTransientThresholdMs(ms: number | null): void {
  quotaThresholdOverride = ms;
}
function resolveQuotaTransientThresholdMs(): number {
  return quotaThresholdOverride ?? QUOTA_TRANSIENT_THRESHOLD_MS;
}

/**
 * Both the total quota-limit polling budget and the maximum reset lead time
 * the tier will wait out. Mirrors `anthropic-direct/query/retry-constants.ts`
 * `TWO_HOURS_MS` — the same 2-hour window Anthropic uses.
 */
export const QUOTA_TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * Fallback wait when a long-retry-after 429 carries no parseable `retry-after`
 * header at all. Uses a 60-second probe cadence: enough time not to hammer the
 * API, short enough to resume promptly once a token bucket or billing hold clears.
 */
export const QUOTA_FALLBACK_WAIT_MS = 60 * 1000;

/** Test injection: override `QUOTA_TWO_HOURS_MS` for fake-timer tests. */
let quotaTwoHoursOverride: number | null = null;
/** @internal Test injection for TWO_HOURS budget. Pass null to restore production default. */
export function __setQuotaTwoHoursMs(ms: number | null): void {
  quotaTwoHoursOverride = ms;
}
function resolveQuotaTwoHoursMs(): number {
  return quotaTwoHoursOverride ?? QUOTA_TWO_HOURS_MS;
}

/** Test injection: override `QUOTA_FALLBACK_WAIT_MS` for fake-timer tests. */
let quotaFallbackOverride: number | null = null;
/** @internal Test injection for fallback wait. Pass null to restore production default. */
export function __setQuotaFallbackWaitMs(ms: number | null): void {
  quotaFallbackOverride = ms;
}
function resolveQuotaFallbackWaitMs(): number {
  return quotaFallbackOverride ?? QUOTA_FALLBACK_WAIT_MS;
}

/**
 * True when `event` is an `error` that should be treated as a quota /
 * usage-limit (long wait) rather than a transient rate-limit (short retry).
 *
 *   ChatGPT `usage_limit_reached` body (any status, or none) → quota limit.
 *   429 with retry-after present AND > 5 min → quota/billing limit → park.
 *   429 with retry-after present AND ≤ 5 min → transient rate-limit → the
 *     connection retry loop in `retry.ts` / `stream-drive.connection.ts`.
 *   429 with no retry-after and no ChatGPT marker → transient with no hint →
 *     exponential backoff by the connection-phase retry (unchanged).
 *
 * The bare-429 case is not parked: a generic OpenAI-compatible endpoint (local
 * shim, api.openai.com, OpenRouter) gives no subscription signal, so a 429 with
 * no retry-after is most likely a per-minute throttle with no backoff hint.
 * Blocking a session for up to 2 hours on that ambiguous signal would be worse
 * than 3 bounded retries. The ChatGPT subscription backend is the exception: it
 * names the limit explicitly in the body, so it is matched by type, not by
 * magnitude.
 */
export function isQuotaLimitErrorEvent(event: ProviderEvent): boolean {
  if (event.type !== 'error') return false;
  if (isChatGptUsageLimitError(event.error)) return true;
  const status = getErrorStatus(event.error);
  if (status !== 429) return false;
  const retryAfterMs = parseRetryAfterMs(event.error);
  // No retry-after header → ambiguous; let connection-phase retry handle it.
  if (retryAfterMs === undefined) return false;
  // Long retry-after → quota/billing limit → park and wait.
  return retryAfterMs > resolveQuotaTransientThresholdMs();
}

/**
 * How long to wait before re-probing, and whether the reset is too far away
 * to wait for at all. The ChatGPT reset time wins over `retry-after`.
 */
function resolveQuotaWait(
  error: Error,
  codex: ChatGptUsageLimitInfo | null,
  now: number,
): { waitMs: number; retryAfterMs: number | undefined; farReset: boolean } {
  const twoHours = resolveQuotaTwoHoursMs();
  const retryAfterMs = parseRetryAfterMs(error);
  if (codex?.resetsAt !== undefined) {
    const untilReset = codex.resetsAt.getTime() - now;
    // A non-positive distance (reset already passed, clock skew) falls back to
    // the probe cadence rather than a zero-delay replay loop.
    const waitMs = untilReset > 0 ? Math.min(untilReset, twoHours) : resolveQuotaFallbackWaitMs();
    return { waitMs, retryAfterMs, farReset: untilReset > twoHours };
  }
  const waitMs = retryAfterMs !== undefined
    ? Math.min(retryAfterMs, twoHours)
    : resolveQuotaFallbackWaitMs();
  return { waitMs, retryAfterMs, farReset: false };
}

/** Build the `paused` event for the first quota-limit 429 of a park. */
function quotaPausedEvent(
  codex: ChatGptUsageLimitInfo | null,
  autoResume: boolean,
): Extract<ProviderEvent, { type: 'paused' }> {
  return {
    type: 'paused',
    reason: 'usage-limit',
    ...(codex?.resetsAt !== undefined ? { resetsAt: codex.resetsAt } : {}),
    autoResume,
    ...(codex !== null ? { provider: 'codex' as const } : {}),
    ...(codex?.plan !== undefined ? { plan: codex.plan } : {}),
  };
}

/** Context threaded through from `turn-driver.ts`. */
export interface QuotaLimitTierContext {
  /** From `config.autoResumeOnUsageLimit ?? true`. */
  autoResumeOnUsageLimit: boolean;
  /** Witness trace writer, passed to `emitSessionPhase` (fire-and-forget). */
  traceWriter: TraceSink | undefined;
  /** Per-turn abort signal; an abort always wins over a wait. */
  signal: AbortSignal;
  /** Session-level liveness check (set true on `close()`). */
  isClosed: () => boolean;
  /** Session id for the paused / resumed events. */
  sessionId: string;
}

/**
 * Wrap one iteration-with-overload-pause call with a quota-limit park + replay
 * loop. Yields all non-quota events through transparently; intercepts quota-429
 * error events to either pause+resume (autoResumeOnUsageLimit=true) or surface
 * immediately (autoResumeOnUsageLimit=false).
 *
 * @param makeIteration  Factory producing a fresh overload-pause-tier generator.
 *   MUST return a NEW generator per call — generators are single-use.
 * @param ctx            Live context from the owning query / turn-driver.
 * @returns The same `IterationResult | null` as the inner tier:
 *   - Successful run → the result from `driveStream` / overload-pause-tier.
 *   - Abort / close / fail-fast → `null`.
 *   - Auto-resume after a reset → the result of the replayed iteration.
 */
export async function* runIterationWithQuotaLimitPause(
  makeIteration: () => AsyncGenerator<ProviderEvent, IterationResult | null>,
  ctx: QuotaLimitTierContext,
): AsyncGenerator<ProviderEvent, IterationResult | null> {
  const pausedAt = Date.now();
  let pauseEmitted = false;
  let resumeEmitted = false;

  for (;;) {
    // ── Manual generator protocol: preserve the typed return value ──────────
    const gen = makeIteration();
    let quotaEvent: Extract<ProviderEvent, { type: 'error' }> | null = null;
    let returnValue: IterationResult | null = null;

    for (;;) {
      const step = await gen.next();
      if (step.done) {
        returnValue = step.value;
        break;
      }
      const event = step.value;
      if (isQuotaLimitErrorEvent(event)) {
        // Consume the generator's final return step (which will be null from
        // driveStream's error path) before breaking so the generator is
        // properly exhausted and GC-able.
        const terminal = await gen.next();
        returnValue = terminal.done ? terminal.value : null;
        // isQuotaLimitErrorEvent guards event.type === 'error', so this cast is safe.
        quotaEvent = event as Extract<ProviderEvent, { type: 'error' }>;
        await gen.return(null);
        break;
      }
      yield event;
    }

    // ── Clean run (no quota-limit error intercepted) ─────────────────────────
    if (quotaEvent === null) {
      if (pauseEmitted && !resumeEmitted) {
        // The iteration succeeded after a park — emit resumed now.
        yield { type: 'resumed', hotSwapped: false };
        void emitSessionPhase(ctx.traceWriter, {
          phase: 'usage_limit_resume',
          durationMs: Date.now() - pausedAt,
          metadata: { source: 'openai-compat-quota', hotSwapped: false },
        });
        resumeEmitted = true;
      }
      return returnValue;
    }

    // ── Close / abort: return null (matching driveStream's close contract) ───
    if (ctx.isClosed()) return null;
    if (ctx.signal.aborted) return null;

    // ── Classify the limit: ChatGPT reset time, else retry-after ────────────
    const codex = classifyChatGptUsageLimit(quotaEvent.error);
    const { waitMs, retryAfterMs, farReset } = resolveQuotaWait(quotaEvent.error, codex, Date.now());
    // A reset beyond the two-hour budget is never waited on, so the pause must
    // not promise an auto-resume it will not deliver.
    const willWait = ctx.autoResumeOnUsageLimit && !farReset;

    // ── Emit paused on the first quota 429 ───────────────────────────────────
    if (!pauseEmitted) {
      yield quotaPausedEvent(codex, willWait);
      void emitSessionPhase(ctx.traceWriter, {
        phase: 'usage_limit_pause',
        metadata: {
          reason: 'usage-limit',
          source: codex !== null ? 'openai-compat-chatgpt' : 'openai-compat-quota',
          hasResetTimestamp: codex !== null ? codex.resetsAt !== undefined : retryAfterMs !== undefined,
          autoResume: willWait,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(codex?.resetsAt !== undefined ? { resetsAt: codex.resetsAt.toISOString() } : {}),
          ...(farReset ? { farReset: true } : {}),
        },
      });
      pauseEmitted = true;
    }

    // ── Fail-fast: autoResumeOnUsageLimit = false, or reset beyond 2h ─────────
    if (!willWait) {
      yield quotaEvent;
      return null;
    }

    // ── Two-hour cap: if total wait already exceeds budget, surface the error ─
    if (Date.now() - pausedAt > resolveQuotaTwoHoursMs()) {
      yield quotaEvent;
      return null;
    }

    // ── Wait out the retry-after (abort-signal-aware) ────────────────────────
    await sleepWithAbort(waitMs, ctx.signal);

    // Re-check after sleeping.
    if (ctx.isClosed()) return null;
    if (ctx.signal.aborted) return null;

    // Still within budget?
    if (Date.now() - pausedAt > resolveQuotaTwoHoursMs()) {
      yield quotaEvent;
      return null;
    }

    // Emit resumed only once, immediately before the first successful replay
    // (handled in the "clean run" branch above). Stay in paused state across
    // failed probes — mirrors the anthropic-direct no-ts path.

    // loop continues → makeIteration() called again (fresh probe)
  }
}
