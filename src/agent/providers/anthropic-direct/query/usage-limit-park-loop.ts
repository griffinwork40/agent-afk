/**
 * Hot-swap park loop primitives shared by both usage-limit pause paths.
 *
 * Extracted from `usage-limit-pause.ts` (#824 split) so both the pause
 * orchestrators and this loop stay under the 350-LOC budget. Behavior is
 * unchanged: same events, same order, same dedup fields, same bail conditions.
 *
 * @module agent/providers/anthropic-direct/query/usage-limit-park-loop
 */

import type { ProviderEvent } from '../../../provider.js';
import { classifyUsageLimitError, waitForHotSwap } from '../usage-limit.js';
import { adoptFreshClient } from './live-client.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import type { RunTurnInput } from '../types.js';
import type { RetryTierContext, TierGenerator, UsageLimitWaitResult } from './retry-context.js';
import { NO_TS_RETRY_INTERVAL_MS, TWO_HOURS_MS } from './retry-constants.js';
import { anthropicLimitErrorEvent } from '../usage-limit.error.js';

/** Join the actual owner's outcome; our abort can end only our join. */
export function joinUsageLimitWait(
  shared: Promise<UsageLimitWaitResult>,
  signal: AbortSignal,
): Promise<UsageLimitWaitResult> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { resolve('aborted'); };
    signal.addEventListener('abort', onAbort, { once: true });
    void shared.then((result) => {
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/**
 * Shared hot-swap wait loop for both the no-timestamp and far-reset parks.
 *
 * Emits `paused` once, then polls `waitForHotSwap` until the limit lifts (a
 * replay probe returns without re-limiting), the abort signal fires, or the
 * TWO_HOURS_MS cap is reached. Emits `resumed` exactly once when the limit
 * lifts. If the cap is reached without a recovery, yields `pendingErrorEvent`
 * and marks the credential snapshot stale.
 *
 * Contract: the caller emits `paused` BEFORE calling this helper so the UI
 * can render the pause panel immediately. The helper assumes that has happened
 * and does NOT emit `paused` itself.
 *
 * @param pollIntervalMs - How long each `waitForHotSwap` iteration waits before
 *   replaying a probe. Defaults to {@link NO_TS_RETRY_INTERVAL_MS} (60 s).
 *   Pass a smaller value (e.g. 30 000) when closed-router is active so
 *   cron-driven credential rotations are picked up twice as fast.
 *
 * @remarks The far-reset + autoResume=true path enters this loop instead of
 * sleeping until the distant reset. Each iteration waits up to
 * `pollIntervalMs` before replaying a probe, so over a 2 h cap the loop can
 * issue up to ~120 API probes (at the default 60 s) on the same account.
 * That is intentional: the primary purpose of this path is to resume
 * immediately on an account hot-swap, and a pure hot-swap-only wait (no timer
 * probes) would require a separate code path, increase complexity, and prevent
 * same-account recovery if the far reset happens to lift earlier than
 * advertised. The probe rate is low enough (~1/min) that it does not
 * constitute meaningful API abuse. A future optimisation could back off
 * exponentially after the first few failed probes, but that is not
 * warranted until measured as a real cost concern. Tracked in #3170 for
 * re-evaluation when probe rate shows up in billing or latency profiles.
 */
export async function* runHotSwapParkLoop(
  ctx: RetryTierContext,
  runInput: RunTurnInput,
  isClosed: () => boolean,
  next: TierGenerator,
  accountId: string,
  startedAt: number,
  pollIntervalMs: number = NO_TS_RETRY_INTERVAL_MS,
): AsyncGenerator<ProviderEvent, void, void> {
  let resumeEmitted = false;
  for (;;) {
    let noTsResult: 'aborted' | 'hot-swap' | 'timer';
    const inFlight = ctx.getUsageLimitWait();
    if (inFlight) {
      // Invariant: joining another session's wait does not confer ownership of
      // the slot — this caller never calls setUsageLimitWait and must not clear
      // it. The owner's finally block manages slot lifecycle; the join only
      // propagates the outcome (or resolves 'aborted' early on our own signal).
      noTsResult = await joinUsageLimitWait(inFlight, runInput.signal);
    } else {
      const wait = waitForHotSwap({
        signal: runInput.signal,
        retryAfterMs: pollIntervalMs,
      });
      ctx.setUsageLimitWait(wait);
      try {
        noTsResult = await wait;
      } finally {
        // Invariant: only the owner of the current slot may clear it.
        if (ctx.getUsageLimitWait() === wait) ctx.setUsageLimitWait(null);
      }
    }

    if (noTsResult === 'aborted') return;

    let resumedAccountId = accountId;
    let adopted = false;
    if (noTsResult === 'hot-swap') {
      // hot-swap: new token in keychain. The Anthropic SDK caches
      // `authToken` at construction, so we MUST rebuild the client — not
      // just the headers — or the replayed turn keeps sending the prior
      // account's bearer token and re-hits the same 429. On refresh failure
      // fall through with the existing client (mirrors the oauth-limit hot-
      // swap path); the timer probe may still succeed once the same-account
      // limit resets.
      const refreshed = await adoptFreshClient(ctx, runInput);
      if (refreshed) {
        resumedAccountId = refreshed.accountId;
        adopted = true;
      }
    }
    if (!adopted) runInput.headers = ctx.rotateHeaders(runInput);

    // Replay the turn. Peek the stream: if the FIRST thing it does is
    // re-hit a usage limit we are still limited — stay paused and wait
    // again. Otherwise the limit lifted: emit `resumed` once, then stream.
    let reLimited: ProviderEvent | null = null;
    let reLimitedResetsAt: Date | undefined;
    for await (const event of next(ctx, runInput, isClosed)) {
      // A probe that re-hits the limit emits the live throttle signal for
      // its own 429 (tracing-fetch → throttle-signals) BEFORE the error.
      // That is not evidence the limit lifted; treating it as such emitted a
      // false `resumed` and leaked the raw 429. Drop it while still paused.
      if (!resumeEmitted && event.type === 'rate_limit') continue;
      if (!resumeEmitted && event.type === 'error') {
        const c = classifyUsageLimitError(event.error);
        if (c && (c.kind === 'oauth-limit' || c.kind === 'oauth-limit-no-ts')) {
          reLimited = event;
          reLimitedResetsAt = c.kind === 'oauth-limit' ? c.resetsAt : undefined;
          break;
        }
      }
      if (!resumeEmitted) {
        yield { type: 'resumed', hotSwapped: noTsResult === 'hot-swap', accountId: resumedAccountId };
        void emitSessionPhase(runInput.traceWriter, {
          phase: 'usage_limit_resume',
          durationMs: Date.now() - startedAt,
          metadata: { source: 'retry-layer', hotSwapped: noTsResult === 'hot-swap' },
        });
        resumeEmitted = true;
      }
      yield event;
    }

    // Resumed (or the turn ended without re-limiting) — done.
    if (!reLimited) return;

    // Use >= so the session at exact equality is also capped (one extra probe
    // at strict > would otherwise fire at the boundary).
    if (Date.now() - startedAt >= TWO_HOURS_MS) {
      // Limit never lifted within the cap — stop polling and surface it.
      ctx.markCredentialSnapshotStale();
      yield anthropicLimitErrorEvent(reLimited, reLimitedResetsAt);
      return;
    }
    // Still limited — loop and wait again (we remain in the paused state).
  }
}
