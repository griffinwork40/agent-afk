/**
 * Stale-credential catch-up: rebuild the SDK client when the credential store
 * holds a different OAuth token than the one the live client was built with.
 *
 * Invariant: the hot-swap detectors in `usage-limit.ts` (`waitForReset`,
 * `waitForHotSwap`) snapshot the credential STORE when the wait starts and
 * fire only on a change AFTER that. An account switch that landed BEFORE the
 * 429 (the operator ran `claude login` between turns, or during an earlier
 * pause that their typed message ended) is therefore invisible to them: the
 * store already holds account B, nothing changes, and the SDK client, which
 * caches its bearer token at construction, keeps sending account A's token
 * and re-hitting the same limit. This module eliminates that failure class
 * by catching up automatically at every turn start and usage-limit check.
 *
 * Two call sites, one comparison ({@link storeAheadOfClient}):
 *   - `source: 'usage-limit'` — once per turn, when a usage-limit 429 is
 *     classified and before any park (`usage-limit-tier.ts`). On a swap the
 *     caller replays the turn instead of parking.
 *   - `source: 'turn-start'` — at the top of every turn
 *     (`RetryLayer.turnWithRetries`), so an account switch with NO error is
 *     picked up on the next message on every surface (REPL, Telegram, web),
 *     not only after a 401/429.
 *
 * Returns `false` (callers proceed exactly as before) when:
 *   - the session is not OAuth, or its credential came from an env var
 *     (see {@link storeAheadOfClient});
 *   - the store is unreadable / empty (an unreadable store is never a swap
 *     target);
 *   - the store matches the client token (nothing to catch up to);
 *   - the refresh failed or did not change the client's token.
 *
 * A same-account token rotation (another process refreshed the shared
 * keychain entry) also differs byte-wise, because Claude OAuth tokens are
 * opaque and carry no account claim. That costs one client rebuild with no
 * network call (`refreshClaudeCodeOauthToken` returns a non-near-expiry token
 * as-is) and leaves the session on a valid token for the same account.
 *
 * Cadence note: the store read in {@link storeAheadOfClient} sits behind the
 * 5-second read cache in `keychain.ts` (`READ_CACHE_TTL_MS = 5_000`). A token
 * change written to the store is therefore visible to the catch-up at most
 * `max(turn_interval, 5s)` after it lands — in practice on the first turn that
 * starts ≥ 5 s after the last cached read. High-frequency back-to-back turns
 * may not see the new token until the cache window expires.
 *
 * @module agent/providers/anthropic-direct/query/usage-limit-catch-up
 */

import { loadClaudeCodeOauthToken } from '../../../auth/keychain.js';
import { env } from '../../../../config/env.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import type { RunTurnInput } from '../types.js';
import type { RetryTierContext } from './retry-context.js';
import { adoptFreshClient } from './live-client.js';

/** Where a catch-up was triggered; selects the trace event it emits. */
export type CatchUpSource = 'usage-limit' | 'turn-start';

/**
 * True when the credential store holds a defined OAuth token that differs
 * from the token the live client was built with.
 *
 * Invariant: only meaningful when the store IS the session's credential
 * source. Credential precedence is `ANTHROPIC_API_KEY` →
 * `CLAUDE_CODE_OAUTH_TOKEN` → store (`credential-resolver.ts`), and the
 * token refresher always rebuilds from the store (`client-setup.ts`). A
 * session authenticated by either an env var OR an explicit slot key
 * (e.g. `AFK_MODEL_<TIER>_API_KEY` written into `config.apiKey` by
 * `slot-credentials.ts`) must never be "caught up": that would silently move
 * it off the operator's pinned credential onto whatever account the keychain
 * holds.
 *
 * Guard precedence (applied in order, first match wins):
 *   1. `credentialFromStore === false` (explicit provenance flag) → never swap.
 *   2. `credentialFromStore === true`  (explicit provenance flag) → env-var
 *      guard is still applied as a cheap defence-in-depth check.
 *   3. `credentialFromStore === undefined` (legacy / test helpers that do not
 *      supply the flag) → fall back to the env-var guard alone.
 *
 * The store read is `background: true` so it is bounded by the keychain
 * timeout and honours the process-wide backoff (no unlock dialog on this path).
 * It is also `quiet` because the turn-start caller runs every turn.
 */
export function storeAheadOfClient(
  ctx: Pick<RetryTierContext, 'authMode' | 'getClientToken' | 'credentialFromStore'>,
): boolean {
  if (ctx.authMode !== 'oauth') return false;
  // Explicit provenance flag: false means the credential came from an env var
  // or an explicit slot key — never swap regardless of what the store holds.
  if (ctx.credentialFromStore === false) return false;
  // Env-var guard: defence-in-depth for both the explicit-true and the
  // legacy-undefined paths. A session using either env var must not be swapped
  // even if credentialFromStore was somehow set true.
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return false;
  const storeToken = loadClaudeCodeOauthToken({ quiet: true, background: true });
  return storeToken !== undefined && storeToken !== ctx.getClientToken();
}

export async function catchUpStaleCredential(
  ctx: RetryTierContext,
  runInput: RunTurnInput,
  source: CatchUpSource = 'usage-limit',
): Promise<boolean> {
  if (!storeAheadOfClient(ctx)) return false;

  // Contract: `adoptFreshClient` mutates `runInput.client` (and
  // `runInput.headers`) unconditionally on success, even when the new client
  // holds the same token as the old one (`refreshed.swapped === false`). That
  // mutation is harmless here: the same-account client is functionally
  // equivalent, and the no-swap early-return below ensures we never emit a
  // spurious trace event for a non-swap.
  const refreshed = await adoptFreshClient(ctx, runInput);
  if (!refreshed || !refreshed.swapped) return false;
  if (source === 'turn-start') {
    void emitSessionPhase(runInput.traceWriter, {
      phase: 'credential_swap',
      metadata: {
        source,
        accountId: refreshed.accountId,
        oldAccountId: refreshed.oldAccountId,
      },
    });
    return true;
  }
  // Witness layer: intentional divergence from the turn-start / compaction
  // paths. Those paths emit `credential_swap` because they stand alone — no
  // surrounding pause/resume lifecycle. This path (`source: 'usage-limit'`)
  // fires inside the usage-limit tier, where the session IS in a park-then-
  // resume lifecycle: the swap is the REASON we do not need to park, so the
  // observable event is a resume (with durationMs: 0, no park) rather than a
  // bare swap. Consumers correlating `credential_swap` events for account-
  // switch telemetry must also watch `usage_limit_resume` with
  // `metadata.hotSwapped === true` to capture this path.
  void emitSessionPhase(runInput.traceWriter, {
    phase: 'usage_limit_resume',
    durationMs: 0,
    metadata: {
      source: 'credential-catch-up',
      hotSwapped: true,
      accountId: refreshed.accountId,
    },
  });
  return true;
}
