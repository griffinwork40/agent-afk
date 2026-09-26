import type { TurnHandles, CompletionWriter } from './shared.js';
import { promoteWithQueuedFlush, previewOneLine, type QueuedFlushCompositor } from './queued-flush.js';
import { palette } from '../../palette.js';

export interface SubagentPromotionContext {
  h: TurnHandles;
  borrowedCompositor: QueuedFlushCompositor | null;
  completionWriter: CompletionWriter | undefined;
}

/**
 * Creates the per-turn Ctrl+B handler. Backgrounds the running foreground
 * subagent and nothing else: if a subagent dispatched by THIS turn is running
 * and promotable, it is detached into a /bgsub job and the main turn keeps
 * streaming in the foreground. When no subagent is promotable, Ctrl+B is a
 * deliberate no-op.
 */
export function makeHandleBackgroundKey(ctx: SubagentPromotionContext): () => void {
  return (): void => {
    const { h, borrowedCompositor, completionWriter } = ctx;
    const control = h.subagentControl;
    if (!control?.hasPromotableForeground()) return;
    void promoteWithQueuedFlush(control, borrowedCompositor, h.onQueuedUserMessage)
      .then(({ jobs, flushedText, flushedPreview }) => {
        const write = (completionWriter ?? { fn: console.log }).fn;
        for (const job of jobs) { write(palette.dim(`  → subagent backgrounded as ${job.jobId}: ${job.label}`)); }
        if (jobs.some((j) => j.sharesWorktree)) write(palette.warning('⚠ Background child is writing to your worktree — edits may conflict until it finishes'));
        if (flushedText !== undefined) {
          write(palette.dim(`  → queued message sent to this turn: ${previewOneLine(flushedPreview ?? flushedText)}`));
        }
      })
      .catch(() => { /* best-effort UI note; promotion itself already happened */ });
  };
}

/**
 * Installs the per-turn Ctrl+B handler on the surface's persistent compositor.
 * The surface's armCompositor closure dereferences this ref on every Ctrl+B press.
 * Cleared in finally so Ctrl+B between turns is a no-op.
 * Only installed when the promotion seam is available (subagentControl).
 */
export function installSubagentPromotion(ctx: SubagentPromotionContext): void {
  if (ctx.h.setBackgroundHandler && ctx.h.subagentControl) {
    ctx.h.setBackgroundHandler(makeHandleBackgroundKey(ctx));
  }
}
