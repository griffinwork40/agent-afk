/**
 * One-shot stale-credential catch-up for an OAuth usage-limit 429.
 *
 * Invariant: the hot-swap detectors in `usage-limit.ts` (`waitForReset`,
 * `waitForHotSwap`) snapshot the credential STORE when the wait starts and
 * fire only on a change AFTER that. An account switch that landed BEFORE the
 * 429 (the operator ran `claude login` between turns, or during an earlier
 * pause that their typed message ended) is therefore invisible to them: the
 * store already holds account B, nothing changes, and the SDK client, which
 * caches its bearer token at construction, keeps sending account A's token
 * and re-hitting the same limit. Before this module the only way out was a
 * manual `/reauth` and then a fresh message.
 *
 * Contract: called once per turn, at the moment a usage-limit 429 is
 * classified and before any park. When the store holds a defined token that
 * differs from the token the live client was built with, rebuild the client
 * and report `true` so the caller replays the turn on the new credential.
 * Returns `false` (the caller parks exactly as before) when:
 *   - the session is not OAuth, or the store is unreadable / empty
 *     (an unreadable store is never a swap target);
 *   - the store matches the client token (nothing to catch up to);
 *   - the refresh failed or did not change the client's token.
 *
 * Bounded at one attempt per turn by the caller. A same-account token
 * rotation (another process refreshed the shared keychain entry) also
 * differs byte-wise, because Claude OAuth tokens are opaque and carry no
 * account claim. It costs one extra request: the replay re-limits, the
 * client token now matches the store, and the normal pause takes over.
 *
 * @module agent/providers/anthropic-direct/query/usage-limit-catch-up
 */

import { loadClaudeCodeOauthToken } from '../../../auth/keychain.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import type { RunTurnInput } from '../types.js';
import type { RetryTierContext } from './retry-context.js';
import { adoptFreshClient } from './live-client.js';

export async function catchUpStaleCredential(
  ctx: RetryTierContext,
  runInput: RunTurnInput,
): Promise<boolean> {
  if (ctx.authMode !== 'oauth') return false;
  const storeToken = loadClaudeCodeOauthToken();
  if (storeToken === undefined || storeToken === ctx.getClientToken()) return false;

  const refreshed = await adoptFreshClient(ctx, runInput);
  if (!refreshed || !refreshed.swapped) return false;
  // Witness layer: a resume with no matching pause, because the turn never
  // parked. `source` distinguishes it from the park-loop resumes.
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
