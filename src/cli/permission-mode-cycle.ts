/**
 * Shift+Tab permission-mode cycle for the REPL.
 *
 * `cyclePermissionMode` advances the session through a two-stop ring:
 * `plan ↔ bypassPermissions`. `default` has been removed — `bypassPermissions`
 * is the baseline mode. Both onShiftTab handlers (the persistent compositor in
 * `surface-setup.ts` and the readLine fallback in `loop-iteration.ts`) call this.
 *
 * Contract: `plan`/`bypass` transitions are pure `setPermissionMode` flips. The
 * plan-mode gate and the bypass allow-all are keyed off `permissionMode` alone
 * with no enter/exit machinery, so the ring sets the mode directly, mirrors
 * `stats.permissionMode` (the value the prompt + status line + gate getters read),
 * repaints, and emits per-mode copy. On a `setPermissionMode` rejection (provider
 * query handle closing/torn down) `stats.permissionMode` is left unchanged and
 * the error is surfaced — mirroring `togglePlanMode`'s failure contract.
 */

import { palette } from './palette.js';
import type { SlashContext } from './slash/types.js';
import { errorMessage } from '../utils/errors.js';

/**
 * The Shift+Tab ring. The ring is a two-stop toggle: `bypassPermissions ↔ plan`.
 * `default` has been removed — `bypassPermissions` is now the baseline mode.
 */
export const PERMISSION_CYCLE = ['plan', 'bypassPermissions'] as const;

type CycleMode = (typeof PERMISSION_CYCLE)[number];

/** The one-line status copy for the mode the ring just landed on. */
export function cycleCopy(mode: CycleMode): string {
  switch (mode) {
    case 'plan':
      return palette.warning('● plan mode ON') +
        palette.dim(' — writes refused; read-only bash runs, mutating bash blocked.');
    case 'bypassPermissions':
      // Shift+Tab is the only live entry into unrestricted mode, so this
      // notice is the sole at-toggle explainer of what unrestricted does.
      return palette.unrestricted('⚡ unrestricted') +
        palette.dim(
          ' — path-approval prompts + containment OFF; read/write any path. ' +
            '(Does not affect ask_question.)',
        );
  }
}

/**
 * Emit the cycle copy. Contract: when a live compositor frame is armed the
 * copy goes to its transient mode-notice row, which the NEXT Shift+Tab
 * overwrites and the next other keystroke clears — so repeated presses toggle
 * one line in place instead of stacking stale lines in scrollback (the status
 * line already carries the persistent mode badge). Without an armed frame
 * (readLine fallback, non-TTY, tests) it falls back to a scrollback line.
 */
function emitCycleCopy(ctx: SlashContext, mode: CycleMode): void {
  const text = cycleCopy(mode);
  if (ctx.getCompositor?.()?.setModeNotice(text)) return;
  ctx.out.line(text);
}

/**
 * Advance one step through the permission-mode ring.
 */
export async function cyclePermissionMode(ctx: SlashContext): Promise<void> {
  const cur = ctx.stats.permissionMode;

  const idx = PERMISSION_CYCLE.indexOf(cur as CycleMode);
  // idx === -1 for any out-of-ring mode (acceptEdits/dontAsk/auto/default) → (−1+1)=0 →
  // start at `plan`. The modulo wraps `bypassPermissions` (last) → `plan`.
  const next = PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length] ?? 'bypassPermissions';

  try {
    await ctx.session.current.setPermissionMode(next);
    ctx.stats.permissionMode = next;
    ctx.ui.repaintStatusLine();
    emitCycleCopy(ctx, next);
  } catch (err) {
    ctx.out.error(
      `Could not switch permission mode: ${errorMessage(err)}`,
    );
  }
}
