/**
 * Shared toggle helper for plan mode + closure-ritual terminator.
 *
 * `togglePlanMode` is used by the /plan slash command, the Shift+Tab
 * keybinding in the REPL input loop, and the closure-ritual terminator
 * `flushPendingPlanExit` — all three paths emit identical copy and update
 * the same stats/status-line plumbing.
 *
 * `flushPendingPlanExit` is the post-turn flip for the D-light closure
 * ritual: when `/plan off` deferred the mode flip (setting
 * `stats.pendingPlanExit = true` and seeding a closure prompt), the REPL
 * calls this helper from `onAfterTurn` after the closure response lands.
 * If the underlying `session.setPermissionMode` call fails (e.g., the
 * provider's query handle is closing or already torn down), the pending
 * flag is preserved so a subsequent `/plan off` force-exits cleanly
 * instead of starting a fresh ritual.
 */

import { palette } from './palette.js';
import type { SlashContext } from './slash/types.js';

let hasShownFirstUseTip = false;

export interface TogglePlanModeOptions {
  /**
   * When the toggle goes plan → default AND this is true, the OFF copy
   * notes that the closure summary was skipped. Set this in the two
   * force-exit paths:
   *   - second `/plan off` while `pendingPlanExit` is true
   *   - Shift+Tab while `pendingPlanExit` is true
   * Leave false (default) in the normal post-closure flush, where the
   * model just emitted the closure summary and the flip is the expected
   * terminus of the ritual.
   */
  closureSummarySkipped?: boolean;
}

export async function togglePlanMode(
  ctx: SlashContext,
  desired?: boolean,
  opts: TogglePlanModeOptions = {},
): Promise<void> {
  const current = ctx.stats.planMode;
  const next = desired !== undefined ? desired : !current;

  try {
    await ctx.session.current.setPermissionMode(next ? 'plan' : 'default');
    ctx.stats.planMode = next;
    ctx.ui.repaintStatusLine();
    if (next) {
      const tip = hasShownFirstUseTip ? '' : palette.dim(' Shift+Tab or /plan to exit.');
      if (!hasShownFirstUseTip) hasShownFirstUseTip = true;
      ctx.out.success(
        palette.warning('● plan mode ON') +
        palette.dim(' — write_file, edit_file, and write-intent bash are refused.') +
        tip,
      );
    } else if (opts.closureSummarySkipped) {
      ctx.out.success(
        palette.success('○ plan mode OFF') +
        palette.dim(' — force-exit (closure summary skipped). Default permissions restored.'),
      );
    } else {
      ctx.out.success(
        palette.success('○ plan mode OFF') + palette.dim(' — default permissions restored'),
      );
    }
  } catch (err) {
    ctx.out.error(
      `Could not toggle plan mode: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Post-turn closure-ritual terminator.
 *
 * Called from the REPL's `onAfterTurn` hook. When the user's previous
 * `/plan off` deferred the flip (set `stats.pendingPlanExit = true`), the
 * closure response from the model has now landed on history — flip the
 * mode to default. Clears `pendingPlanExit` only if the flip succeeded,
 * so a transient `setPermissionMode` failure leaves the user able to
 * retry `/plan off` as a clean force-exit instead of starting a fresh
 * ritual.
 *
 * Idempotent: no-op when `pendingPlanExit` is unset.
 */
export async function flushPendingPlanExit(ctx: SlashContext): Promise<void> {
  if (!ctx.stats.pendingPlanExit) return;
  await togglePlanMode(ctx, false);
  if (!ctx.stats.planMode) {
    ctx.stats.pendingPlanExit = false;
  }
}
