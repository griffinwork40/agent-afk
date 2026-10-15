/**
 * REPL-turn hook dispatcher — `UserPromptSubmit` (pre-turn). Extracted from
 * `runInputLoop` so policy hook wiring never grows that grandfathered function.
 * (Stop is dispatched by the session layer — see `wireStopHook`.)
 *
 * The dispatcher is a thin wrapper: it translates hook-registry primitives
 * (injectContext, HookBlockedError, HookHandlerTimeoutError) into the caller's
 * concrete next-action without exposing registry internals to the loop.
 *
 * @module cli/commands/interactive/loop-iteration.hooks
 */

import type { UserPromptSubmitContext } from '../../../agent/hooks.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';
import { HookBlockedError } from '../../../utils/errors.js';
import { HookHandlerTimeoutError } from '../../../agent/hook-registry.js';
import { palette } from '../../palette.js';
import type { InteractiveCtx } from './shared.js';

/**
 * Result of the pre-turn `UserPromptSubmit` hook dispatch.
 *
 * `shouldContinue` — a handler blocked or timed out; caller should `continue`
 *   to the next loop iteration (the turn is dropped).
 * `runText` — the prompt text to use for this turn, possibly extended by a
 *   handler-returned `injectContext` prefix. Equals the input `runText` when
 *   no injection was returned.
 */
export interface UpsResult {
  shouldContinue: boolean;
  runText: string;
}

/**
 * Dispatch the `UserPromptSubmit` hook before a turn.
 *
 * Returns `{ shouldContinue: true }` when the turn must be dropped (block or
 * timeout). Rethrows `AbortError` and all unexpected errors unchanged.
 *
 * @param runText  The prompt text about to be submitted.
 * @param ctx      Interactive session context.
 */
export async function dispatchUserPromptSubmit(runText: string, ctx: InteractiveCtx): Promise<UpsResult> {
  if (!ctx.hookRegistry) return { shouldContinue: false, runText };
  try {
    const upsCtx: UserPromptSubmitContext = {
      event: 'UserPromptSubmit',
      prompt: runText,
      sessionId: ctx.stats.sessionId,
    };
    const upsDecision = await ctx.hookRegistry.dispatch(upsCtx);
    const merged = upsDecision.injectContext ? upsDecision.injectContext + runText : runText;
    return { shouldContinue: false, runText: merged };
  } catch (err) {
    if (err instanceof HookBlockedError) {
      ctx.replRenderer.writeLine(
        palette.warning('⊘ Turn blocked by hook') +
          (err.reason ? palette.dim(`: ${sanitizeForDisplay(err.reason)}`) : ''),
      );
      ctx.statusLine.rearm();
      return { shouldContinue: true, runText };
    }
    if (err instanceof HookHandlerTimeoutError) {
      ctx.replRenderer.writeLine(
        palette.warning('⊘ Turn blocked by hook') +
          palette.dim(`: handler timed out after ${err.timeoutMs}ms`),
      );
      ctx.statusLine.rearm();
      return { shouldContinue: true, runText };
    }
    throw err; // AbortError and unexpected errors propagate.
  }
}
