/**
 * Ctrl+B background-promotion handlers for the interactive turn.
 *
 * Ctrl+B dispatch order (#2542):
 *   1. Subagent (existing) — if a promotable foreground subagent is running,
 *      detach it into a /bgsub job. The main turn keeps streaming.
 *   2. Detachable tool (new) — if no subagent is promotable but a bash call
 *      (or future compose call) has registered with the DetachableToolRegistry,
 *      fire `detachAll()` to free the model's turn while the process continues.
 *   3. No-op — if neither is available, Ctrl+B does nothing.
 *
 * Whole-turn backgrounding is deliberately NOT implemented here (no third step).
 * The subagent promotion path in step 1 is the only mechanism that moves a
 * running turn's future results into the background; detaching a bash call
 * in step 2 only frees the immediate tool-call await and delivers the result
 * out-of-band when the process finishes.
 *
 * @module cli/commands/interactive/turn-handler.bg-promotion
 */

import type { TurnHandles, CompletionWriter } from './shared.js';
import { promoteWithQueuedFlush, previewOneLine, type QueuedFlushCompositor } from './queued-flush.js';
import { palette } from '../../palette.js';

export interface SubagentPromotionContext {
  h: TurnHandles;
  borrowedCompositor: QueuedFlushCompositor | null;
  completionWriter: CompletionWriter | undefined;
}

/**
 * Creates the per-turn Ctrl+B handler.
 *
 * Implements the three-step dispatch order documented in the module header.
 * Returns a zero-argument function suitable for wiring into the compositor's
 * `onBackground` slot.
 */
export function makeHandleBackgroundKey(ctx: SubagentPromotionContext): () => void {
  return (): void => {
    const { h, borrowedCompositor, completionWriter } = ctx;
    const write = (completionWriter ?? { fn: console.log }).fn;

    // Step 1: Subagent promotion (existing path).
    const control = h.subagentControl;
    if (control?.hasPromotableForeground()) {
      void promoteWithQueuedFlush(control, borrowedCompositor, h.onQueuedUserMessage)
        .then(({ jobs, flushedText, flushedPreview }) => {
          for (const job of jobs) { write(palette.dim(`  → subagent backgrounded as ${job.jobId}: ${job.label}`)); }
          if (jobs.some((j) => j.sharesWorktree)) write(palette.warning('⚠ Background child is writing to your worktree — edits may conflict until it finishes'));
          if (flushedText !== undefined) {
            write(palette.dim(`  → queued message sent to this turn: ${previewOneLine(flushedPreview ?? flushedText)}`));
          }
        })
        .catch(() => { /* best-effort UI note; promotion itself already happened */ });
      return;
    }

    // Step 2: Detachable tool call (new — #2542, bash only; compose is follow-up).
    const detachReg = h.detachRegistry;
    if (detachReg?.hasDetachable()) {
      detachReg.detachAll();
      write(palette.dim('  → bash detached; result will be delivered with the next user message'));
      return;
    }

    // Step 3: No-op (nothing to detach).
  };
}

/**
 * Installs the per-turn Ctrl+B handler on the surface's persistent compositor.
 * The surface's armCompositor closure dereferences this ref on every Ctrl+B press.
 * Cleared in finally so Ctrl+B between turns is a no-op.
 * Only installed when at least one of the promotion seams is available.
 */
export function installSubagentPromotion(ctx: SubagentPromotionContext): void {
  const { h } = ctx;
  if (h.setBackgroundHandler && (h.subagentControl || h.detachRegistry)) {
    h.setBackgroundHandler(makeHandleBackgroundKey(ctx));
  }
}
