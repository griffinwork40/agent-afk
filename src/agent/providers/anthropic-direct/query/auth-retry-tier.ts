/**
 * Innermost retry tier: single-401 token refresh and replay.
 *
 * Extracted verbatim from `retry-layer.ts` (#824 split); the class keeps a
 * `yield*` delegate. Behavior is unchanged — see {@link RetryTierContext} for
 * why the tier reads live accessors instead of captured fields.
 *
 * @module agent/providers/anthropic-direct/query/auth-retry-tier
 */

import type { ProviderEvent } from '../../../provider.js';
import { runTurn } from '../loop.js';
import type { AnthropicClientLike, RunTurnInput } from '../types.js';
import type { RetryTierContext } from './retry-context.js';

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
 * Inner tier: on a single 401, refresh once and replay. Deduplicates
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
    if (event.type === 'error' && isRetryableAuth(ctx, event.error)) {
      authError = event;
      break;
    }
    yield event;
  }

  if (!authError) return;

  // Delegate to the shared refresh helper. Same dedup field
  // (`refreshPromise`) coalesces this call with any concurrent
  // `forceClientRefresh()` from `/reauth` or a hot-swap branch above.
  const refreshed = await ctx.forceClientRefresh();
  if (!refreshed) {
    yield authError;
    return;
  }
  runInput.client = ctx.getClient() as unknown as AnthropicClientLike;
  runInput.headers = ctx.rotateHeaders(runInput);

  yield* runTurn(runInput);
}
