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
import { classifyUsageLimitError, waitForReset, waitForHotSwap } from '../usage-limit.js';
import { loadClaudeCodeOauthToken, parseAccountIdentifier } from '../../../../cli/keychain.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import type { AnthropicClientLike, RunTurnInput } from '../types.js';
import type { RetryTierContext, TierGenerator } from './retry-context.js';
import { NO_TS_RETRY_INTERVAL_MS, TWO_HOURS_MS } from './retry-constants.js';

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
): AsyncGenerator<ProviderEvent, void, void> {
  const accountId = parseAccountIdentifier(loadClaudeCodeOauthToken() ?? '');
  yield { type: 'paused', reason: 'usage-limit', accountId, autoResume: ctx.autoResumeOnUsageLimit };
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
    },
  });

  if (!ctx.autoResumeOnUsageLimit) {
    // Fail-fast (autoResumeOnUsageLimit=false, e.g. a subagent fork): no
    // replay follows, so the operator's fix — logging into a different
    // account — needs the NEXT turn to pick up the new credential
    // without a manual `/reauth`. See `credentialSnapshotStale`.
    ctx.markCredentialSnapshotStale();
    yield pendingErrorEvent;
    return;
  }

  const startedAt = Date.now();
  let resumeEmitted = false;
  for (;;) {
    let noTsResult: 'aborted' | 'hot-swap' | 'timer';
    const inFlight = ctx.getUsageLimitWait();
    if (inFlight) {
      // A concurrent session already waiting — dedup by treating any
      // resolve as 'aborted' since we can't share this wait.
      noTsResult = 'aborted';
    } else {
      const wait = waitForHotSwap({
        signal: runInput.signal,
        retryAfterMs: NO_TS_RETRY_INTERVAL_MS,
      });
      ctx.setUsageLimitWait(wait);
      try {
        noTsResult = await wait;
      } finally {
        ctx.setUsageLimitWait(null);
      }
    }

    if (noTsResult === 'aborted') return;

    let resumedAccountId = accountId;
    if (noTsResult === 'hot-swap') {
      // hot-swap: new token in keychain. The Anthropic SDK caches
      // `authToken` at construction, so we MUST rebuild the client — not
      // just the headers — or the replayed turn keeps sending the prior
      // account's bearer token and re-hits the same 429. On refresh failure
      // fall through with the existing client (mirrors the oauth-limit hot-
      // swap path); the timer probe may still succeed once the same-account
      // limit resets.
      const refreshed = await ctx.forceClientRefresh();
      if (refreshed) {
        runInput.client = ctx.getClient() as unknown as AnthropicClientLike;
        resumedAccountId = refreshed.accountId;
      }
    }
    runInput.headers = ctx.rotateHeaders(runInput);

    // Replay the turn. Peek the stream: if the FIRST thing it does is
    // re-hit a usage limit we are still limited — stay paused and wait
    // again. Otherwise the limit lifted: emit `resumed` once, then stream.
    let reLimited: ProviderEvent | null = null;
    for await (const event of next(ctx, runInput, isClosed)) {
      if (!resumeEmitted && event.type === 'error') {
        const c = classifyUsageLimitError(event.error);
        if (c && (c.kind === 'oauth-limit' || c.kind === 'oauth-limit-no-ts')) {
          reLimited = event;
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

    if (Date.now() - startedAt > TWO_HOURS_MS) {
      // Limit never lifted within the cap — stop polling and surface it.
      yield reLimited;
      return;
    }
    // Still limited — loop and wait again (we remain in the paused state).
  }
}

/**
 * `oauth-limit` path — a 429 carrying a `|<unix-ts>` reset timestamp.
 *
 * Wait for the deadline (or a hot-swap), then replay. Reset windows beyond
 * {@link TWO_HOURS_MS} are surfaced immediately without waiting.
 */
export async function* usageLimitResetPause(
  ctx: RetryTierContext,
  runInput: RunTurnInput,
  isClosed: () => boolean,
  next: TierGenerator,
  pendingErrorEvent: ProviderEvent,
  resetsAt: Date,
): AsyncGenerator<ProviderEvent, void, void> {
  if (resetsAt.getTime() - Date.now() > TWO_HOURS_MS) {
    // Reset too far in the future — surface the error without waiting.
    // No replay follows this bail either, so mark the snapshot stale (see
    // `credentialSnapshotStale`) — same reasoning as the no-ts fail-fast.
    ctx.markCredentialSnapshotStale();
    yield pendingErrorEvent;
    return;
  }

  const accountId = parseAccountIdentifier(loadClaudeCodeOauthToken() ?? '');
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
    // above: no replay follows, so the next turn must force a credential
    // re-resolve instead of waiting on `/reauth`.
    ctx.markCredentialSnapshotStale();
    yield pendingErrorEvent;
    return;
  }

  let result: 'aborted' | 'timer' | 'hot-swap';
  const inFlight = ctx.getUsageLimitWait();
  if (inFlight) {
    result = await inFlight;
  } else {
    const wait = waitForReset({ resetsAt, signal: runInput.signal });
    ctx.setUsageLimitWait(wait);
    try {
      result = await wait;
    } finally {
      ctx.setUsageLimitWait(null);
    }
  }

  if (result === 'aborted') return;

  let resumedAccountId = accountId;
  if (result === 'hot-swap') {
    // hot-swap: user logged into a different account during the wait. Same
    // SDK-caches-authToken constraint as the no-ts path above — rebuild
    // the client or the replayed turn keeps using the prior account's
    // bearer token.
    const refreshed = await ctx.forceClientRefresh();
    if (refreshed) {
      runInput.client = ctx.getClient() as unknown as AnthropicClientLike;
      resumedAccountId = refreshed.accountId;
    }
    // If refresh failed, fall through with the old client — the inner
    // 401 path may still recover if the prior token has since expired.
  }
  // 'timer' resolution: deadline passed, same account, same token — no
  // client rebuild needed. Headers still rotated to refresh the request-id.
  runInput.headers = ctx.rotateHeaders(runInput);
  yield { type: 'resumed', hotSwapped: result === 'hot-swap', accountId: resumedAccountId };
  void emitSessionPhase(runInput.traceWriter, {
    phase: 'usage_limit_resume',
    durationMs: Date.now() - pausedAt,
    metadata: { source: 'retry-layer', hotSwapped: result === 'hot-swap' },
  });

  yield* next(ctx, runInput, isClosed);
}
