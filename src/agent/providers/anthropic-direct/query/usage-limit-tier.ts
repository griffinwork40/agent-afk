/**
 * Outer retry tier: 429 classification, transient rate-limit replay, and
 * dispatch into the two usage-limit parks.
 *
 * Extracted verbatim from `retry-layer.ts` (#824 split); the parks themselves
 * live in `usage-limit-pause.ts`. Behavior is unchanged.
 *
 * @module agent/providers/anthropic-direct/query/usage-limit-tier
 */

import type { ProviderEvent } from '../../../provider.js';
import { classifyUsageLimitError } from '../usage-limit.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import type { RunTurnInput } from '../types.js';
import type { RetryTierContext, TierGenerator } from './retry-context.js';
import {
  RATE_LIMIT_RETRY_DEFAULT_WAIT_MS,
  RATE_LIMIT_RETRY_JITTER_MS,
  RATE_LIMIT_RETRY_MAX_WAIT_MS,
  RATE_LIMIT_TRANSIENT_MAX_RETRIES,
} from './retry-constants.js';
import { usageLimitNoTimestampPause, usageLimitResetPause } from './usage-limit-pause.js';

/**
 * Outer tier: intercept 429 usage-limit errors and (when enabled)
 * wait+replay. Deduplicates concurrent wait calls via the layer's shared
 * `usageLimitWaitPromise`.
 *
 * Handles two sub-kinds:
 *   - `oauth-limit`      — 429 with `|<unix-ts>` reset timestamp: wait for
 *     the deadline (or a hot-swap), then replay. Reset windows beyond 2h are
 *     surfaced immediately without waiting.
 *   - `oauth-limit-no-ts` — 429 without a timestamp (API omitted it): emit
 *     `paused` with no `resetsAt`, then poll-retry the turn on a fixed cadence
 *     (and wake immediately on a hot-swap) until the limit lifts, the user
 *     aborts, or the 2h cap is hit. Stays in the `paused` state across failed
 *     probes and emits `resumed` only once the limit genuinely lifts.
 *
 * Additionally handles `rate-limit-transient` (429 + `retry-after` header,
 * no `|ts`): wait out the server's backoff hint (clamped + jittered) and
 * silently replay the turn, up to {@link RATE_LIMIT_TRANSIENT_MAX_RETRIES}
 * attempts per turn, after which the error surfaces as before.
 *
 * @param next - the auth-retry tier this one wraps.
 */
export async function* turnWithUsageLimitRetry(
  ctx: RetryTierContext,
  runInput: RunTurnInput,
  isClosed: () => boolean,
  next: TierGenerator,
): AsyncGenerator<ProviderEvent, void, void> {
  let pendingErrorEvent: ProviderEvent | null = null;
  let resetsAt: Date | null = null;
  let noTimestamp = false;
  // Per-turn transient 429 replay budget. Local to this generator, so each
  // user turn gets a fresh RATE_LIMIT_TRANSIENT_MAX_RETRIES attempts.
  let rateLimitRetries = 0;

  for (;;) {
    let transientRetryAfterMs: number | undefined;
    let sawTransient = false;

    for await (const event of next(ctx, runInput, isClosed)) {
      if (event.type === 'error') {
        const c = classifyUsageLimitError(event.error);
        if (c && c.kind === 'oauth-limit') {
          resetsAt = c.resetsAt;
          pendingErrorEvent = event;
          break;
        }
        if (c && c.kind === 'oauth-limit-no-ts') {
          noTimestamp = true;
          pendingErrorEvent = event;
          break;
        }
        // `rate-limit-transient` (a standard API rate-limit 429, distinct
        // from OAuth subscription exhaustion) does NOT enter the pause/
        // wait paths below. The SDK has already auto-retried it twice, but
        // on account-level RPM/ITPM collisions (several daemon sessions
        // firing at once) that is not enough: honor `retry-after` here and
        // replay the turn, bounded at RATE_LIMIT_TRANSIENT_MAX_RETRIES per
        // turn. Once the budget is exhausted this branch stops matching
        // and the error surfaces via `yield event` below — never parked in
        // a 2-hour subscription-reset poll. See classifyUsageLimitError.
        if (
          c &&
          c.kind === 'rate-limit-transient' &&
          rateLimitRetries < RATE_LIMIT_TRANSIENT_MAX_RETRIES
        ) {
          sawTransient = true;
          transientRetryAfterMs = c.retryAfterMs;
          break;
        }
      }
      yield event;
    }

    if (!sawTransient) break;

    rateLimitRetries += 1;
    if (isClosed() || runInput.signal.aborted) return;

    // Honor the server's backoff hint, clamped so a pathological header
    // cannot park the turn indefinitely; add jitter so concurrent sessions
    // hitting the same account limit de-synchronize their replays.
    const baseWaitMs = Math.min(
      transientRetryAfterMs ?? RATE_LIMIT_RETRY_DEFAULT_WAIT_MS,
      RATE_LIMIT_RETRY_MAX_WAIT_MS,
    );
    const waitMs = baseWaitMs + Math.floor(Math.random() * RATE_LIMIT_RETRY_JITTER_MS);
    // Witness layer: record the backoff so the replayed round is legible in
    // the trace (mirrors loop.ts's mid-stream overload phase). Fire-and-
    // forget; trace latency must never stall the retry.
    void emitSessionPhase(runInput.traceWriter, {
      phase: 'rate_limit',
      metadata: {
        reason: 'retry-after',
        source: 'retry-layer',
        attempt: rateLimitRetries,
        waitMs,
      },
    });
    await sleepWithAbort(waitMs, runInput.signal);
    if (isClosed() || runInput.signal.aborted) return;

    // Rotate the request id before replaying (mirrors the oauth-limit
    // resume paths). Same client, same token — only the headers refresh.
    runInput.headers = ctx.rotateHeaders(runInput);
    // Loop: replay the turn.
  }

  if (!pendingErrorEvent) {
    return;
  }

  // ── oauth-limit-no-ts path ─────────────────────────────────────────────
  if (noTimestamp) {
    yield* usageLimitNoTimestampPause(ctx, runInput, isClosed, next, pendingErrorEvent);
    return;
  }

  // ── oauth-limit path (has reset timestamp) ────────────────────────────
  if (!resetsAt) {
    return;
  }

  yield* usageLimitResetPause(ctx, runInput, isClosed, next, pendingErrorEvent, resetsAt);
}
