/**
 * Innermost retry tier: single-401/403 token refresh and replay.
 *
 * 401 Unauthorized: the token itself is invalid or expired. Refreshing
 * re-reads the OS keychain and rebuilds the SDK client.
 *
 * 403 Forbidden (seat removed / subscription inactive): the token is valid
 * but the account lacks API access — typically because the premium seat was
 * removed during an account swap. Refreshing picks up a different account's
 * token if the keychain now holds a different account's token, the replay
 * succeeds; if not, the error surfaces immediately. In API-key mode no
 * refresher is wired, so this returns false and the 403 surfaces without retry.
 * Both paths attempt exactly one refresh-and-replay.
 *
 * # Delayed second refresh (cache-bypass)
 *
 * When the first replay itself returns a 401, the in-process keychain read
 * cache (5-second TTL, `keychain.ts`) may have served the old revoked token to
 * `forceClientRefresh`. We clear the cache and wait
 * {@link CACHE_BYPASS_DELAY_MS} before a second refresh attempt — long enough
 * for a concurrent keychain write to settle — then replay once more. Only
 * attempted on 401 (not 403): a re-403 on replay means the credential was
 * valid but the seat is gone, so a cache race cannot explain it.
 *
 * Extracted from `retry-layer.ts` (#824 split); the class keeps a `yield*`
 * delegate. See {@link RetryTierContext} for why the tier reads live
 * accessors instead of captured fields.
 *
 * @module agent/providers/anthropic-direct/query/auth-retry-tier
 */

import type { ProviderEvent } from '../../../provider.js';
import { runTurn } from '../loop.js';
import type { RunTurnInput } from '../types.js';
import type { RetryTierContext } from './retry-context.js';
import { adoptFreshClient } from './live-client.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { clearTokenCache } from '../../../auth/keychain.js';

/**
 * Delay before the cache-bypass second refresh attempt, in milliseconds.
 * Long enough for a concurrent keychain write-back to complete; short enough
 * not to stall the turn noticeably in the common (non-race) case.
 */
export const CACHE_BYPASS_DELAY_MS = 150;

/**
 * A 401 is retryable only in OAuth mode with a refresher wired.
 *
 * Invariant: `status` is read off the error's OWN properties. Fast mode
 * re-wraps a thrown SDK error to annotate the message (`annotateFastError` in
 * `turn-request.ts`); that wrapper must copy `status` across or this predicate
 * goes blind and a refreshable 401 surfaces as a hard failure instead.
 */
export function isRetryableAuth(ctx: RetryTierContext, error: Error): boolean {
  return (
    ctx.authMode === 'oauth' &&
    ctx.tokenRefresher !== undefined &&
    'status' in error &&
    (error as unknown as { status: number }).status === 401
  );
}

/**
 * A 403 may be recoverable in OAuth mode when the operator has already
 * switched accounts via `afk login` in another terminal.
 *
 * Common 403 causes: seat/subscription removed, billing lapsed, org-policy
 * block, or the transient `oauth_not_allowed_for_organization` race (#3467).
 * All get one opportunistic refresh attempt in OAuth mode: if the keychain
 * now holds a different account's token, the replay succeeds; if not, the
 * error surfaces immediately. In API-key mode no refresher is wired, so
 * this returns false and the 403 surfaces without retry.
 */
export function isRefreshablePermissionDenied(ctx: RetryTierContext, error: Error): boolean {
  return (
    ctx.authMode === 'oauth' &&
    ctx.tokenRefresher !== undefined &&
    'status' in error &&
    (error as unknown as { status: number }).status === 403
  );
}

/**
 * Inner tier: on a single 401 or 403, refresh once and replay. Deduplicates
 * concurrent refresh calls via the layer's shared `refreshPromise`.
 *
 * When the first replay itself returns a 401, a second cache-bypassing refresh
 * attempt is made after a short delay (see {@link CACHE_BYPASS_DELAY_MS}).
 */
export async function* turnWithAuthRetry(
  ctx: RetryTierContext,
  runInput: RunTurnInput,
  isClosed: () => boolean,
): AsyncGenerator<ProviderEvent, void, void> {
  let authError: ProviderEvent | null = null;

  for await (const event of runTurn(runInput)) {
    if (isClosed()) return;
    if (
      event.type === 'error' &&
      (isRetryableAuth(ctx, event.error) || isRefreshablePermissionDenied(ctx, event.error))
    ) {
      authError = event;
      break;
    }
    yield event;
  }

  if (!authError) return;

  // Extract the numeric HTTP status for the trace record (401 or 403).
  // Invariant: `authError` can only be set when `isRetryableAuth` or
  // `isRefreshablePermissionDenied` matched, both of which require
  // `ctx.tokenRefresher !== undefined`. The `no-refresher` outcome is
  // therefore impossible here; `refresh-null` is the earliest failure point.
  const triggerStatus = (authError.error as unknown as { status?: number }).status ?? 0;

  // Delegate to the shared refresh helper. Same dedup field
  // (`refreshPromise`) coalesces this call with any concurrent
  // `forceClientRefresh()` from the turn-start catch-up or a hot-swap branch above.
  const refreshed = await adoptFreshClient(ctx, runInput);
  if (!refreshed) {
    // Refresher was wired but returned null (token read failed / keychain locked).
    void emitSessionPhase(runInput.traceWriter, {
      phase: 'auth_retry_outcome',
      metadata: { outcome: 'refresh-null', status: triggerStatus, authMode: ctx.authMode },
    });
    yield authError;
    return;
  }

  // Replay the turn. Collect all events so the trace record (emitted before
  // the terminal yield) names the correct outcome ('replay-failed' vs
  // 'replayed'). Emitting AFTER the final `yield event` is unreachable in
  // production because TurnStreamRunner.runStream breaks on the done/error
  // event and abandons the generator via .return(), so we accumulate first,
  // emit the phase, then yield — matching the refresh-null pattern above.
  const replayEvents: ProviderEvent[] = [];
  for await (const event of runTurn(runInput)) {
    replayEvents.push(event);
  }

  // Check whether the replay itself produced a 401. If so, the in-process
  // keychain cache may have served the old revoked token to `forceClientRefresh`
  // above. Clear the cache, wait briefly, and try a second refresh + replay.
  // Only for 401 (not 403): a re-403 means the seat is gone, not a cache race.
  const replayAuth401 = replayEvents.find(
    (e) =>
      e.type === 'error' &&
      isRetryableAuth(ctx, e.error),
  );

  if (replayAuth401 && !isClosed()) {
    // Brief delay: give a concurrent keychain write-back time to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, CACHE_BYPASS_DELAY_MS));

    if (isClosed()) {
      void emitSessionPhase(runInput.traceWriter, {
        phase: 'auth_retry_outcome',
        metadata: { outcome: 'replay-failed', status: triggerStatus, authMode: ctx.authMode },
      });
      for (const event of replayEvents) {
        yield event;
      }
      return;
    }

    // Clear only the token value cache — not the DoS backoff guard
    // (_readBackoffUntil). clearKeychainCache/_resetKeychainReadCache zero the
    // backoff too, which would re-enable rapid-fire keychain subprocess reads
    // inside a retry loop where a prior timeout may already have armed it.
    clearTokenCache();

    const refreshed2 = await adoptFreshClient(ctx, runInput);
    if (refreshed2) {
      // Prepend the first replay's non-error events before the second replay's
      // events. Those tool/content rounds already executed and their results are
      // in runInput.messages; the second replay continues after them. Without
      // this, the UI hides executed operations and recordToolOutput loses their
      // Done-evidence records.
      const replay1NonErrorEvents = replayEvents.filter((e) => e.type !== 'error');
      const replay2Events: ProviderEvent[] = [];
      for await (const event of runTurn(runInput)) {
        replay2Events.push(event);
      }
      const replay2Errored = replay2Events.some((e) => e.type === 'error');
      void emitSessionPhase(runInput.traceWriter, {
        phase: 'auth_retry_outcome',
        metadata: {
          outcome: replay2Errored ? 'replay-failed' : 'replayed',
          status: triggerStatus,
          authMode: ctx.authMode,
          cacheBypass: true,
        },
      });
      for (const event of replay1NonErrorEvents) {
        yield event;
      }
      for (const event of replay2Events) {
        yield event;
      }
      return;
    }
    // Second refresh returned null — fall through to yield the first replay's events.
    void emitSessionPhase(runInput.traceWriter, {
      phase: 'auth_retry_outcome',
      metadata: {
        outcome: 'replay-failed',
        status: triggerStatus,
        authMode: ctx.authMode,
        cacheBypass: true,
        secondRefreshNull: true,
      },
    });
    for (const event of replayEvents) {
      yield event;
    }
    return;
  }

  const replayErrored = replayEvents.some((e) => e.type === 'error');
  void emitSessionPhase(runInput.traceWriter, {
    phase: 'auth_retry_outcome',
    metadata: {
      outcome: replayErrored ? 'replay-failed' : 'replayed',
      status: triggerStatus,
      authMode: ctx.authMode,
    },
  });
  for (const event of replayEvents) {
    yield event;
  }
}
