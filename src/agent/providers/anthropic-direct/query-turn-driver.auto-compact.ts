/**
 * Auto-compaction helper extracted from query-turn-driver.ts to stay within the
 * 350-line file ceiling. Behavior is identical — only the physical location
 * changed.
 *
 * @module agent/providers/anthropic-direct/query-turn-driver.auto-compact
 */

import type { ProviderEvent } from '../../provider.js';
import { autoCompactLimitFor } from '../../model-limits.js';
import { contextWindowTokensUsed, shouldAutoCompact } from './query/auto-compact.js';
import { HookBlockedError } from '../../../utils/errors.js';
import type { TurnDriverContext } from './query-turn-driver.js';

/**
 * Auto-compaction: fire at the natural turn boundary — after the per-turn
 * event loop exits and the abort slot is cleared — so we never trigger while a
 * tool call is in flight.
 *
 * External constraint: `abort.isIdle()` MUST be true here (cleared by
 * `abort.clear(controller)` in the caller's finally) so compact-handler's own
 * isIdle() guard passes and the 'turn-in-flight' bail is not hit spuriously.
 * Do not call this from inside the inner for-await — compact() mutates
 * state.messages in place and must only run at a clean turn boundary, never
 * mid-tool-call.
 *
 * Yields nothing; it is a generator purely so the caller's `yield*` keeps the
 * original inline control flow (a throw here propagates identically).
 */
export async function* maybeAutoCompact(ctx: TurnDriverContext): AsyncGenerator<ProviderEvent, void, void> {
  if (ctx.state.autoCompactThreshold === undefined || ctx.state.closed) return;
  const usage = ctx.state.lastUsage;
  // requestedModel (not the wire currentModel) so 1M aliases use their
  // true window — opus_1m resolves to the same wire id as opus but must
  // compact at ~90% of 1M, not 200k. autoCompactLimitFor additionally
  // caps the DEFAULT `sonnet` at a 200k working budget: its 1M window is
  // truthful, but base sessions compact early for cost/latency, while the
  // `sonnet_1m` opt-in bypasses the cap. See model-limits.ts.
  const compactionLimit = autoCompactLimitFor(ctx.state.requestedModel);
  if (usage === null || compactionLimit <= 0) return;
  // Use the context-window footprint (input + cache_read +
  // cache_creation + output for the last round), NOT input+output
  // alone — Anthropic's input_tokens excludes cache, so the cached
  // conversation prefix (often the bulk of the window) must be
  // counted or compaction never fires before the window overflows.
  const usedTokens = contextWindowTokensUsed(usage);
  if (!shouldAutoCompact(usedTokens, compactionLimit, ctx.state.autoCompactThreshold)) return;
  // Fire-and-await: compact() is async but we hold the turn
  // boundary here (generator suspended at promptIterator.next()
  // on the next iteration). Awaiting inline keeps the ordering
  // deterministic and avoids a dangling promise race.
  //
  // Invariant: dispatch PreCompact(trigger:'auto') BEFORE compact()
  // so registered hooks can block or observe the operation, mirroring
  // the manual-compact paths in REPL (/compact) and Telegram. A block
  // decision throws HookBlockedError — caught here to skip compaction
  // for this turn without propagating to the outer error handler.
  try {
    if (ctx.hookRegistry) {
      await ctx.hookRegistry.dispatch({
        event: 'PreCompact',
        sessionId: ctx.initSessionId,
        trigger: 'auto',
      });
    }
    const compactResult = await ctx.compact();
    // Reset lastUsage after compaction so the overflow guard (#962) does not
    // false-positive on the next turn: the stale count is no longer a valid
    // lower bound once history has been truncated. The next API call will
    // repopulate it from the actual response.
    // Conditioned on `compacted` — a no-op (history too short, summarization
    // failure) must preserve the near-limit evidence; unconditionally nulling
    // it would skip both the guard and auto-compaction on the next turn.
    if (compactResult.compacted) ctx.state.lastUsage = null;
  } catch (compactErr) {
    if (compactErr instanceof HookBlockedError) {
      // Hook blocked auto-compaction — skip this turn's compaction
      // without surfacing an error; the session continues normally.
    } else {
      throw compactErr;
    }
  }
}
