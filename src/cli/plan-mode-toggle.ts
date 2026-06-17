/**
 * Shared toggle helper for plan mode.
 *
 * `togglePlanMode` is used by the /plan slash command and the Shift+Tab
 * keybinding in the REPL input loop. Both paths emit identical copy and
 * update the same stats/status-line plumbing. It flips the session permission
 * mode (`'plan'` <-> `'default'`) and mirrors the result onto
 * `stats.permissionMode` — the value the REPL prompt and status line read.
 *
 * Exit semantics differ by entry point and live in the callers, not here:
 *   - `/plan off` (slash command) flips to default, then seeds a turn that
 *     saves the plan to a file and implements it (see `slash/commands/plan.ts`).
 *   - Shift+Tab calls this helper raw — a bare flip with no seeded turn, the
 *     "exit without implementing" escape hatch.
 *
 * If `setPermissionMode` rejects (e.g. the provider's query handle is closing
 * or already torn down), `stats.permissionMode` is left unchanged and the
 * failure is surfaced via `ctx.out.error` so the caller can detect a no-op flip.
 */

import { palette } from './palette.js';
import type { SlashContext } from './slash/types.js';

let hasShownFirstUseTip = false;

export async function togglePlanMode(
  ctx: SlashContext,
  desired?: boolean,
): Promise<void> {
  const current = ctx.stats.permissionMode === 'plan';
  const next = desired !== undefined ? desired : !current;

  try {
    await ctx.session.current.setPermissionMode(next ? 'plan' : 'default');
    ctx.stats.permissionMode = next ? 'plan' : 'default';
    ctx.ui.repaintStatusLine();
    if (next) {
      const tip = hasShownFirstUseTip
        ? ''
        : palette.dim(' /plan off saves the plan + implements; Shift+Tab just exits.');
      if (!hasShownFirstUseTip) hasShownFirstUseTip = true;
      ctx.out.success(
        palette.warning('● plan mode ON') +
        palette.dim(' — writes are refused; read-only bash runs, mutating bash is blocked.') +
        tip,
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
