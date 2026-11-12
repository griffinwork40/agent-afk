/**
 * Innermost retry tier: single-401/403 token refresh and replay.
 *
 * 401 Unauthorized: the token itself is invalid or expired. Refreshing
 * re-reads the OS keychain and rebuilds the SDK client.
 *
 * 403 Forbidden (seat removed / subscription inactive): the token is valid
 * but the account lacks API access — typically because the premium seat was
 * removed during an account swap. Refreshing picks up a different account's
 * token if the operator already ran `afk login` in a side terminal; if the
 * keychain still holds the same token, the replay re-403s and surfaces
 * cleanly. Both paths attempt exactly one refresh-and-replay.
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

  // Delegate to the shared refresh helper. Same dedup field
  // (`refreshPromise`) coalesces this call with any concurrent
  // `forceClientRefresh()` from the turn-start catch-up or a hot-swap branch above.
  const refreshed = await adoptFreshClient(ctx, runInput);
  if (!refreshed) {
    yield authError;
    return;
  }

  yield* runTurn(runInput);
}
