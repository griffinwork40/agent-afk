/**
 * The two usage-limit park-and-replay paths, split by whether the 429 carried
 * a reset timestamp.
 *
 * Extracted verbatim from `retry-layer.ts` (#824 split) so both the tier entry
 * and the parks stay under the 350-LOC budget. Behavior is unchanged: same
 * events, same order, same dedup fields, same bail conditions.
 *
 * @module agent/providers/anthropic-direct/query/usage-limit-pause
 */

import type { ProviderEvent } from '../../../provider.js';
import { waitForReset } from '../usage-limit.js';
import { adoptFreshClient, liveAccountId } from './live-client.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import type { RunTurnInput } from '../types.js';
import type { RetryTierContext, TierGenerator } from './retry-context.js';
import { TWO_HOURS_MS } from './retry-constants.js';
import { anthropicLimitErrorEvent } from '../usage-limit.error.js';
import { joinUsageLimitWait, runHotSwapParkLoop } from './usage-limit-park-loop.js';

export { joinUsageLimitWait } from './usage-limit-park-loop.js';

/**
 * `oauth-limit-no-ts` path — a 429 with no reset timestamp.
 *
 * No authoritative deadline exists, so poll-retry the turn on
 * {@link NO_TS_RETRY_INTERVAL_MS} — replaying to probe whether the limit has
 * lifted — while still waking immediately on a keychain hot-swap. Stays in the
 * `paused` state across failed probes and emits `resumed` only once the limit
 * genuinely lifts, so the UI's "auto-resume when the limit resets" promise is
 * actually kept on a same-account reset (previously this path waited on a
 * hot-swap ONLY, so a same-account reset never resumed and the session hung
 * forever). Bounded at {@link TWO_HOURS_MS} — past that the error surfaces
 * instead of polling forever.
 */
export async function* usageLimitNoTimestampPause(
  ctx: RetryTierContext,
  runInput: RunTurnInput,
  isClosed: () => boolean,
  next: TierGenerator,
  pendingErrorEvent: ProviderEvent,
  pollIntervalMs?: number,
): AsyncGenerator<ProviderEvent, void, void> {
  const startedAt = Date.now();
  // waitDeadline bounds the park at TWO_HOURS_MS from now so a subagent's idle
  // watchdog and pause-aware ceiling cover the park even though resetsAt is
  // absent. Only set when we will actually park: a fail-fast pause ends with
  // the error right after this event, so advertising a 2h window would lie.
  yield {
    type: 'paused',
    reason: 'usage-limit',
    // accountId is only needed when we will actually park (auto-resume path);
    // read it lazily so fail-fast callers never touch the keychain.
    accountId: ctx.autoResumeOnUsageLimit
      ? liveAccountId(ctx)
      : undefined,
    autoResume: ctx.autoResumeOnUsageLimit,
    ...(ctx.autoResumeOnUsageLimit ? { waitDeadline: new Date(startedAt + TWO_HOURS_MS) } : {}),
    provider: 'anthropic',
  };
  // Witness layer: a usage-limit park is otherwise invisible in the trace —
  // the turn simply stops emitting for up to two hours. Record it so the
  // stall is legible (mirrors the `rate_limit` phase for transient backoff).
  // Fire-and-forget; trace latency must never stall the pause/resume.
  void emitSessionPhase(runInput.traceWriter, {
    phase: 'usage_limit_pause',
    metadata: {
      reason: 'usage-limit',
      source: 'retry-layer',
      hasResetTimestamp: false,
      autoResume: ctx.autoResumeOnUsageLimit,
      failFast: !ctx.autoResumeOnUsageLimit,
    },
  });

  if (!ctx.autoResumeOnUsageLimit) {
    // Fail-fast (autoResumeOnUsageLimit=false, e.g. a subagent fork): no
    // replay follows, so the operator's fix — logging into a different
    // account — needs the NEXT turn to pick up the new credential via
    // the turn-start credential catch-up. See `credentialSnapshotStale`.
    ctx.markCredentialSnapshotStale();
    yield anthropicLimitErrorEvent(pendingErrorEvent);
    return;
  }

  const accountId = liveAccountId(ctx);
  yield* runHotSwapParkLoop(
    ctx, runInput, isClosed, next, accountId, startedAt, pollIntervalMs,
  );
}

/**
 * `oauth-limit` path — a 429 carrying a `|<unix-ts>` reset timestamp.
 *
 * Wait for the deadline (or a hot-swap), then replay. Reset windows beyond
 * {@link TWO_HOURS_MS} are surfaced immediately without waiting when
 * `autoResumeOnUsageLimit` is false. When `autoResumeOnUsageLimit` is true,
 * a far-reset window enters the hot-swap wait loop (bounded at TWO_HOURS_MS)
 * instead of surfacing the error immediately — because an account switch during
 * that window can resume the turn within the 2-hour cap even when the original
 * account's reset is days away.
 *
 * UI copy for the far-reset park: `resetsAt` is left undefined so the REPL and
 * Telegram show "No reset time available / auto-resume on account switch" rather
 * than a days-away timestamp that would be false (we actually give up after 2h,
 * not at resetsAt). `waitDeadline` is set to parkStart + TWO_HOURS_MS so the
 * watchdog and pause-ceiling arm accurately.
 */
export async function* usageLimitResetPause(
  ctx: RetryTierContext,
  runInput: RunTurnInput,
  isClosed: () => boolean,
  next: TierGenerator,
  pendingErrorEvent: ProviderEvent,
  resetsAt: Date,
  pollIntervalMs?: number,
): AsyncGenerator<ProviderEvent, void, void> {
  const isFarReset = resetsAt.getTime() - Date.now() > TWO_HOURS_MS;

  if (isFarReset) {
    if (!ctx.autoResumeOnUsageLimit) {
      // Reset too far in the future AND auto-resume is off (the default for
      // every subagent fork): surface the error without waiting, exactly as
      // before this path learned to park. No replay follows this bail, so
      // mark the snapshot stale (see `credentialSnapshotStale`) — same
      // reasoning as the no-ts fail-fast.
      ctx.markCredentialSnapshotStale();
      yield anthropicLimitErrorEvent(pendingErrorEvent, resetsAt);
      return;
    }

    // Far reset + autoResume=true: park in the hot-swap loop bounded at 2h.
    // Do NOT emit the real resetsAt — it is days away, which would display
    // a false "resumes at <distant time>" to the user. Instead emit no resetsAt
    // (→ "no reset time available / resume on account switch") and set
    // waitDeadline so watchdog/ceiling arm for exactly the 2h park window.
    const accountId = liveAccountId(ctx);
    const startedAt = Date.now();
    const waitDeadline = new Date(startedAt + TWO_HOURS_MS);
    yield {
      type: 'paused',
      reason: 'usage-limit',
      accountId,
      autoResume: true,
      waitDeadline,
      provider: 'anthropic',
      // resetsAt intentionally omitted: displaying the real distant timestamp
      // would mislead the user (we give up after 2h, not at the far reset).
    };
    void emitSessionPhase(runInput.traceWriter, {
      phase: 'usage_limit_pause',
      metadata: {
        reason: 'usage-limit',
        source: 'retry-layer',
        hasResetTimestamp: true,
        farReset: true,
        resetsAt: resetsAt.toISOString(),
        autoResume: true,
      },
    });
    yield* runHotSwapParkLoop(
      ctx, runInput, isClosed, next, accountId, startedAt, pollIntervalMs,
    );
    return;
  }

  const accountId = liveAccountId(ctx);
  const pausedAt = Date.now();
  // External constraint: this event must carry `autoResume` BEFORE the
  // autoResumeOnUsageLimit branch below decides what comes next, so the UI
  // layer can render truthful copy on the very first paint of the panel.
  // If we deferred this signal to the resumed/error event, the panel would
  // briefly mislead the user with stale "send the message again" instructions.
  yield {
    type: 'paused',
    reason: 'usage-limit',
    resetsAt,
    accountId,
    autoResume: ctx.autoResumeOnUsageLimit,
    provider: 'anthropic',
  };
  // Witness layer: bracket the park so `afk trace show` explains the stall
  // (see the no-ts pause above). Carries the reset deadline for context.
  void emitSessionPhase(runInput.traceWriter, {
    phase: 'usage_limit_pause',
    metadata: {
      reason: 'usage-limit',
      source: 'retry-layer',
      hasResetTimestamp: true,
      autoResume: ctx.autoResumeOnUsageLimit,
      resetsAt: resetsAt.toISOString(),
    },
  });

  if (!ctx.autoResumeOnUsageLimit) {
    // Fail-fast, has-resetsAt variant — same reasoning as the no-ts branch
    // above: no replay follows, so the next turn's credential catch-up
    // must force a re-resolve. See `credentialSnapshotStale`.
    ctx.markCredentialSnapshotStale();
    yield anthropicLimitErrorEvent(pendingErrorEvent, resetsAt);
    return;
  }

  let result: 'aborted' | 'timer' | 'hot-swap';
  const inFlight = ctx.getUsageLimitWait();
  if (inFlight) {
    // Invariant: joining another session's wait does not confer ownership of
    // the slot — this caller never calls setUsageLimitWait and must not clear
    // it. The owner's finally block manages slot lifecycle; the join only
    // propagates the outcome (or resolves 'aborted' early on our own signal).
    result = await joinUsageLimitWait(inFlight, runInput.signal);
  } else {
    const wait = waitForReset({ resetsAt, signal: runInput.signal });
    ctx.setUsageLimitWait(wait);
    try {
      result = await wait;
    } finally {
      // Invariant: a replacement wait belongs to a different owner.
      if (ctx.getUsageLimitWait() === wait) ctx.setUsageLimitWait(null);
    }
  }

  if (result === 'aborted') return;

  let resumedAccountId = accountId;
  let adopted = false;
  if (result === 'hot-swap') {
    // hot-swap: user logged into a different account during the wait. Same
    // SDK-caches-authToken constraint as the no-ts path above — rebuild
    // the client or the replayed turn keeps using the prior account's
    // bearer token.
    const refreshed = await adoptFreshClient(ctx, runInput);
    if (refreshed) {
      resumedAccountId = refreshed.accountId;
      adopted = true;
    }
    // If refresh failed, fall through with the old client — the inner
    // 401 path may still recover if the prior token has since expired.
  }
  // 'timer' resolution: deadline passed, same account, same token — no
  // client rebuild needed. Headers still rotated to refresh the request-id.
  if (!adopted) runInput.headers = ctx.rotateHeaders(runInput);
  yield { type: 'resumed', hotSwapped: result === 'hot-swap', accountId: resumedAccountId };
  void emitSessionPhase(runInput.traceWriter, {
    phase: 'usage_limit_resume',
    durationMs: Date.now() - pausedAt,
    metadata: { source: 'retry-layer', hotSwapped: result === 'hot-swap' },
  });

  yield* next(ctx, runInput, isClosed);
}
