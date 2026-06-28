/**
 * Shared toggle helper for plan mode.
 *
 * `togglePlanMode` is used by the `/plan` slash command. (Shift+Tab no longer
 * calls it directly — it routes through `cyclePermissionMode` in
 * `permission-mode-cycle.ts`, which advances the ring default → plan → bypass.)
 * It flips the session permission mode and mirrors the result onto
 * `stats.permissionMode` — the value the REPL prompt and status line read.
 *
 * Entering plan flips to `'plan'`. EXITING plan RESTORES the mode the session
 * was in before it entered plan (captured by `AgentSession` on the flip into
 * plan, read back via `getPrePlanMode()`), falling back to `'default'` when
 * none was captured — so a user who planned from bypass lands back in bypass.
 * This mirrors the model-callable `exit_plan_mode` tool's restore behavior.
 *
 * Exit semantics live in the caller, not here: `/plan off` exits plan then
 * seeds a turn that saves the plan to a file and implements it (see
 * `slash/commands/plan.ts`).
 *
 * If `setPermissionMode` rejects (e.g. the provider's query handle is closing
 * or already torn down), `stats.permissionMode` is left unchanged and the
 * failure is surfaced via `ctx.out.error` so the caller can detect a no-op flip.
 */

import { palette } from './palette.js';
import type { SlashContext } from './slash/types.js';
import type { PermissionMode } from '../agent/types/sdk-types.js';

let hasShownFirstUseTip = false;

/** Status-line suffix describing the mode `/plan off` restored on exit. */
function describeRestoredMode(mode: PermissionMode): string {
  switch (mode) {
    case 'bypassPermissions':
      return 'bypass restored — no prompts, read/write any path';
    case 'acceptEdits':
      return 'accept-edits restored — edits auto-approved';
    case 'default':
    default:
      return 'default permissions restored';
  }
}

export async function togglePlanMode(
  ctx: SlashContext,
  desired?: boolean,
): Promise<void> {
  const current = ctx.stats.permissionMode === 'plan';
  const next = desired !== undefined ? desired : !current;

  // Exiting plan restores the pre-plan mode (falls back to 'default' when none
  // was captured); entering plan flips to 'plan'. The `?.` guards session-likes
  // / test doubles that predate getPrePlanMode (it resolves undefined → default).
  const target: PermissionMode = next
    ? 'plan'
    : (ctx.session.current.getPrePlanMode?.() ?? 'default');

  try {
    await ctx.session.current.setPermissionMode(target);
    ctx.stats.permissionMode = target;
    ctx.ui.repaintStatusLine();
    if (next) {
      const tip = hasShownFirstUseTip
        ? ''
        : palette.dim(' /plan off saves the plan + implements; Shift+Tab cycles to the next mode.');
      if (!hasShownFirstUseTip) hasShownFirstUseTip = true;
      ctx.out.success(
        palette.warning('● plan mode ON') +
        palette.dim(' — writes are refused; read-only bash runs, mutating bash is blocked.') +
        tip,
      );
    } else {
      ctx.out.success(
        palette.success('○ plan mode OFF') + palette.dim(` — ${describeRestoredMode(target)}`),
      );
    }
  } catch (err) {
    ctx.out.error(
      `Could not toggle plan mode: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
