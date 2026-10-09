/**
 * The live client's credential: adopting a rebuilt client into a replay, and
 * naming the account that client actually authenticates as.
 *
 * Invariant: the Anthropic SDK reads `authToken` once at client construction
 * and sends `Authorization: Bearer <cached>` on every request, with no re-read
 * hook. A credential change therefore takes effect only when (a) the client is
 * REBUILT (`forceClientRefresh`) and (b) the in-flight `runInput` is pointed at
 * the rebuilt client. Rotating headers alone replays on the old account and
 * re-hits the same 429. Every refresh-then-replay site goes through
 * {@link adoptFreshClient} so no caller can do (a) without (b).
 *
 * Invariant: the credential STORE (keychain / `.credentials.json`) and the
 * live client can disagree. The operator may have run `claude login` since the
 * client was built. Anything that NAMES the active account must read the
 * client's token, not the store, or it reports the account the session is not
 * using. See {@link liveAccountId}.
 *
 * @module agent/providers/anthropic-direct/query/live-client
 */

import { loadClaudeCodeOauthToken, parseAccountIdentifier } from '../../../auth/keychain.js';
import type { AnthropicClientLike, RunTurnInput } from '../types.js';
import type { RetryTierContext } from './retry-context.js';

type RefreshResult = Awaited<ReturnType<RetryTierContext['forceClientRefresh']>>;

/**
 * Rebuild the SDK client and point `runInput` at it with fresh headers.
 *
 * Contract: returns the refresh result on success, with `runInput.client` and
 * `runInput.headers` already updated. Returns `null` when the refresh failed
 * or no refresher is wired (api-key mode); `runInput` is left untouched so the
 * caller can fall back to the existing client.
 */
export async function adoptFreshClient(
  ctx: Pick<RetryTierContext, 'forceClientRefresh' | 'getClient' | 'rotateHeaders'>,
  runInput: RunTurnInput,
): Promise<RefreshResult> {
  const refreshed = await ctx.forceClientRefresh();
  if (!refreshed) return null;
  runInput.client = ctx.getClient() as unknown as AnthropicClientLike;
  runInput.headers = ctx.rotateHeaders(runInput);
  return refreshed;
}

/**
 * Account identifier for the token the live client was built with. Falls
 * back to the store only when the client token is unknown (api-key mode, or
 * the store was unreadable when the client was built).
 */
export function liveAccountId(ctx: Pick<RetryTierContext, 'getClientToken'>): string {
  return parseAccountIdentifier(ctx.getClientToken() ?? loadClaudeCodeOauthToken() ?? '');
}
