/**
 * REPL-turn hook dispatchers — `UserPromptSubmit` (pre-turn) and `Stop`
 * (post-turn). Extracted from `runInputLoop` so policy hook wiring never
 * grows that grandfathered function.
 *
 * Both dispatchers are thin wrappers: they translate hook-registry primitives
 * (injectContext, HookBlockedError, HookHandlerTimeoutError) into the caller's
 * concrete next-action without exposing registry internals to the loop.
 *
 * @module cli/commands/interactive/loop-iteration.hooks
 */

import type { UserPromptSubmitContext } from '../../../agent/hooks.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';
import { AbortError, HookBlockedError } from '../../../utils/errors.js';
import { HookHandlerTimeoutError } from '../../../agent/hook-registry.js';
import { debugLog } from '../../../utils/debug.js';
import { palette } from '../../palette.js';
import type { InteractiveCtx } from './shared.js';

/** Per-handler timeout for the post-turn Stop notification. Tighter than the
 *  registry default (HOOK_HANDLER_TIMEOUT_MS = 30s) because Stop fires every
 *  REPL turn — a notification hook must not stall the prompt for 30s × N
 *  handlers. */
const STOP_HOOK_HANDLER_TIMEOUT_MS = 5_000;

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

/**
 * Dispatch the `Stop` hook after a completed turn.
 *
 * Returns the merged `injectContext` string from all non-blocking handlers,
 * or `undefined` when no injection was produced. `AbortError` propagates;
 * block and timeout errors are surfaced as dim completion-writer notices
 * (they do NOT abort the loop — Stop block semantics are advisory post-turn).
 *
 * @param ctx                     Interactive session context.
 * @param currentTerminalKind     Parsed verdict kind from this turn, if any.
 * @param currentDoneHasEvidence  Whether the Done verdict had corroborating evidence.
 * @param currentDoneClassification  Evidence classification for Done verdicts.
 */
export async function dispatchStop(
  ctx: InteractiveCtx,
  currentTerminalKind: 'done' | 'blocked' | 'asking' | 'interrupted' | undefined,
  currentDoneHasEvidence: boolean | undefined,
  currentDoneClassification: 'no-code-changes' | 'verified' | 'unverified' | undefined,
): Promise<string | undefined> {
  if (!ctx.hookRegistry) return undefined;
  try {
    const stopDecision = await ctx.hookRegistry.dispatch(
      {
        event: 'Stop',
        sessionId: ctx.stats.sessionId,
        ...(currentTerminalKind !== undefined ? { terminalState: currentTerminalKind } : {}),
        ...(currentDoneHasEvidence !== undefined ? { doneHasCorroboratingEvidence: currentDoneHasEvidence } : {}),
        ...(currentDoneClassification !== undefined ? { doneEvidenceClassification: currentDoneClassification } : {}),
      },
      undefined,
      STOP_HOOK_HANDLER_TIMEOUT_MS,
    );
    if (stopDecision.injectContext && stopDecision.injectContext.trim().length > 0) {
      return stopDecision.injectContext;
    }
    return undefined;
  } catch (err) {
    if (err instanceof AbortError) throw err;
    if (err instanceof HookHandlerTimeoutError) {
      debugLog('[stop hook] handler timed out');
      ctx.completionWriter.fn(palette.dim('  [stop hook] timed out'));
    } else if (err instanceof HookBlockedError) {
      ctx.completionWriter.fn(
        palette.dim(`  [stop hook] blocked: ${sanitizeForDisplay(err.reason ?? 'no reason given')}`),
      );
    } else {
      debugLog('[stop hook] unexpected error: ' + String(err));
    }
    return undefined;
  }
}
