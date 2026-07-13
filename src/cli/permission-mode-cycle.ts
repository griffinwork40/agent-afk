/**
 * Shift+Tab permission-mode cycle for the REPL.
 *
 * `cyclePermissionMode` advances the session through a fixed ring of three
 * permission modes — `default → plan → bypassPermissions → default` — one step
 * per Shift+Tab press. It is the keyboard speed-lane that replaces the historical
 * Shift+Tab plan-toggle: instead of flipping `plan ↔ default`, it walks the ring.
 * Both onShiftTab handlers (the persistent compositor in `surface-setup.ts` and
 * the readLine fallback in `loop-iteration.ts`) call this.
 *
 * Invariant: AFK (`autonomous`) is deliberately NOT in the ring. Entering AFK
 * runs heavy, non-idempotent machinery — Telegram push-budget reset, swapping the
 * elicitation handler to the ledger channel, starting an abort-watcher, setting a
 * presence marker (all in `toggleAfkMode`) — that must not fire on a transient
 * keypress pass-through. AFK stays on the `/afk` command. The one concession: if
 * the session is ALREADY in `autonomous` (the operator ran `/afk on`), Shift+Tab
 * exits AFK via `toggleAfkMode(ctx, false)` — which runs the full teardown — and
 * lands on `default`. So the key does something sensible from AFK without ever
 * ENTERING it; the next press resumes the ring at `default → plan`.
 *
 * Contract: `plan`/`bypass`/`default` transitions are pure `setPermissionMode`
 * flips. The plan-mode gate and the bypass allow-all are keyed off
 * `permissionMode` alone with no enter/exit machinery, so the ring sets the mode
 * directly, mirrors `stats.permissionMode` (the value the prompt + status line +
 * gate getters read), repaints, and emits per-mode copy. On a `setPermissionMode`
 * rejection (provider query handle closing/torn down) `stats.permissionMode` is
 * left unchanged and the error is surfaced — mirroring `togglePlanMode`'s
 * failure contract.
 */

import { toggleAfkMode } from './afk-mode-toggle.js';
import { palette } from './palette.js';
import type { SlashContext } from './slash/types.js';

/**
 * The Shift+Tab ring. `autonomous` (AFK) is intentionally excluded — see the
 * module-level invariant. Order is load-bearing: `default → plan` preserves the
 * historical "first press from the prompt enters plan" muscle memory, and the
 * wrap `bypassPermissions → default` keeps the cycle forward-only.
 */
export const PERMISSION_CYCLE = ['default', 'plan', 'bypassPermissions'] as const;

type CycleMode = (typeof PERMISSION_CYCLE)[number];

/** Emit the one-line status copy for the mode the ring just landed on. */
function emitCycleCopy(ctx: SlashContext, mode: CycleMode): void {
  switch (mode) {
    case 'plan':
      ctx.out.success(
        palette.warning('● plan mode ON') +
          palette.dim(' — writes refused; read-only bash runs, mutating bash blocked.'),
      );
      return;
    case 'bypassPermissions':
      // Plain line (not the ✓ channel) so bypass reads as a cool "full-power"
      // badge rather than a red alarm. Since the `/bypass` slash command was
      // retired, Shift+Tab is the only live entry into bypass, so this notice is
      // the sole at-toggle explainer of what bypass does.
      ctx.out.line(
        palette.bypass('⚡ bypass ON') +
          palette.dim(
            ' — path-approval prompts + containment OFF; read/write any path. ' +
              '(Does not affect ask_question.)',
          ),
      );
      return;
    case 'default':
      ctx.out.success(
        palette.success('○ default') +
          palette.dim(' — path containment + approval prompts restored.'),
      );
      return;
  }
}

/**
 * Advance one step through the permission-mode ring. See module doc for the
 * AFK-exit concession and the failure contract.
 */
export async function cyclePermissionMode(ctx: SlashContext): Promise<void> {
  const cur = ctx.stats.permissionMode;

  // AFK is not a ring stop. If we are in it (operator ran `/afk on`), exit
  // cleanly via the helper that runs the teardown, landing on `default`.
  if (cur === 'autonomous') {
    await toggleAfkMode(ctx, false);
    return;
  }

  const idx = PERMISSION_CYCLE.indexOf(cur as CycleMode);
  // idx === -1 for any out-of-ring mode (acceptEdits/dontAsk/auto) → (−1+1)=0 →
  // start at `default`. The modulo wraps `bypassPermissions` (last) → `default`.
  const next = PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length] ?? 'default';

  try {
    await ctx.session.current.setPermissionMode(next);
    ctx.stats.permissionMode = next;
    ctx.ui.repaintStatusLine();
    emitCycleCopy(ctx, next);
  } catch (err) {
    ctx.out.error(
      `Could not switch permission mode: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
