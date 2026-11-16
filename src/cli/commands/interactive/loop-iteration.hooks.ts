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
 * `injectContext` — handler-returned context. The caller queues it on the
 *   session that sends the turn, never prepends it to the prompt text.
 */
export interface UpsResult {
  shouldContinue: boolean;
  injectContext?: string;
}

/** The narrow session surface that delivers hook context inside the envelope. */
export interface HookContextQueue {
  queueFrameworkContext(text: string): void;
}

/**
 * Queue pending Stop context, then UserPromptSubmit context, on the session
 * about to send the turn, so both ride that turn inside one harness envelope.
 */
export function queueTurnHookContext(
  session: HookContextQueue,
  stopContext: string | undefined,
  upsContext: string | undefined,
): void {
  if (stopContext) session.queueFrameworkContext(stopContext);
  if (upsContext) session.queueFrameworkContext(upsContext);
}

/**
 * Dispatch the `UserPromptSubmit` hook before a turn.
 *
 * Returns `{ shouldContinue: true }` when the turn must be dropped (block or
 * timeout). Rethrows `AbortError` and all unexpected errors unchanged.
 *
 * @param runText  The prompt text about to be submitted (never Stop context).
 * @param ctx      Interactive session context.
 */
export async function dispatchUserPromptSubmit(runText: string, ctx: InteractiveCtx): Promise<UpsResult> {
  if (!ctx.hookRegistry) return { shouldContinue: false };
  try {
    const upsCtx: UserPromptSubmitContext = {
      event: 'UserPromptSubmit',
      prompt: runText,
      sessionId: ctx.stats.sessionId,
    };
    const upsDecision = await ctx.hookRegistry.dispatch(upsCtx);
    return upsDecision.injectContext
      ? { shouldContinue: false, injectContext: upsDecision.injectContext }
      : { shouldContinue: false };
  } catch (err) {
    if (err instanceof HookBlockedError) {
      ctx.replRenderer.writeLine(
        palette.warning('⊘ Turn blocked by hook') +
          (err.reason ? palette.dim(`: ${sanitizeForDisplay(err.reason)}`) : ''),
      );
      ctx.statusLine.rearm();
      return { shouldContinue: true };
    }
    if (err instanceof HookHandlerTimeoutError) {
      ctx.replRenderer.writeLine(
        palette.warning('⊘ Turn blocked by hook') +
          palette.dim(`: handler timed out after ${err.timeoutMs}ms`),
      );
      ctx.statusLine.rearm();
      return { shouldContinue: true };
    }
    throw err; // AbortError and unexpected errors propagate.
  }
}
