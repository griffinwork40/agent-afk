/**
 * /plan — toggle plan mode, with a closure ritual on exit.
 *
 * Usage:
 *   /plan                    — toggle plan mode on/off
 *   /plan on                 — set plan mode on (clears pending exit if any)
 *   /plan off                — request exit; first call starts the closure
 *                              ritual, second call (while pending) force-exits
 *   /plan <free text>        — enter plan mode and pre-fill the prompt with
 *                              <free text> for immediate submission
 *
 * Enforcement: in plan mode, write_file, edit_file, and write-intent bash
 * commands are refused by the plan-mode gate hook (PR #255). This is
 * hook-level refusal in agent-afk's own harness — the model is not lied
 * to about which permission mode it is in, and there is no upstream
 * permission-mode layer being relied on. (agent-afk talks to the
 * Anthropic Messages API directly via `@anthropic-ai/sdk`; it does not
 * use `@anthropic-ai/claude-agent-sdk`.)
 *
 * Posture: the `anthropic-direct` provider appends a planning-topology
 * addendum to the system prompt whenever permissionMode === 'plan', so the
 * model sees plan mode at turn start and knows which skills match each step
 * of the shape. The addendum stays active during the closure-ritual turn.
 *
 * Closure ritual: `/plan off` (or bare `/plan` while in plan mode) does NOT
 * flip the mode immediately. It sets `stats.pendingPlanExit = true`, keeps
 * `planMode` true (so write enforcement is unbroken), and returns a
 * `{ kind: 'submit' }` result that seeds the closure prompt as the next
 * user message. The model emits its final plan in three sections; after
 * that turn completes, `onAfterTurn` in the REPL loop performs the flip.
 *
 * Escape hatches:
 *   - `/plan off` again while pending = force-exit (immediate flip, no turn).
 *   - Shift+Tab from the REPL = immediate flip via raw `togglePlanMode`,
 *     bypasses the ritual. (Keyboard speed lane.)
 *   - `/plan on` while pending = cancel pending, stay in plan mode.
 */

import { togglePlanMode } from '../../plan-mode-toggle.js';
import { palette } from '../../palette.js';
import type { SlashCommand, SlashContext, SlashResult } from '../types.js';

/**
 * The closure prompt seeded into the user's next message buffer when the
 * ritual begins. The model has already been told what to emit by the
 * plan-mode system-prompt addendum; this prompt is the explicit ask.
 */
export const PLAN_MODE_CLOSURE_PROMPT = [
  'You are about to exit plan mode. Before I flip permissions back to default on the next turn, emit your final plan in three sections:',
  '',
  '  - **Chosen approach** — the plan you recommend, in one to three sentences.',
  '  - **Risks named** — the concrete failure modes, constraints, or unknowns this plan does not eliminate.',
  '  - **Alternatives considered** — the options you weighed and why you rejected them.',
  '',
  'This is the record. Be specific. Do not propose write actions in this turn — writes are still refused until the mode flips.',
].join('\n');

async function startClosureRitual(ctx: SlashContext): Promise<SlashResult> {
  ctx.stats.pendingPlanExit = true;
  ctx.ui.repaintStatusLine();
  // State-first copy: lead with "still ON" so the user does not mistake
  // the deferred exit for a normal exit. Both escape hatches named with
  // their exact gestures. Mirrors the badge style of the ON message
  // (`●` warning, dim secondary text).
  ctx.out.success(
    palette.warning('● plan exit queued') +
    palette.dim(
      ' — plan mode still ON; writes still refused.' +
      ' Submitting closure summary (chosen approach, risks, alternatives);' +
      ' mode flips after the model responds.' +
      ' Force-exit now: /plan off again or Shift+Tab.',
    ),
  );
  return { kind: 'submit', message: PLAN_MODE_CLOSURE_PROMPT };
}

async function forceExit(ctx: SlashContext): Promise<SlashResult> {
  // Clear the pending flag BEFORE calling togglePlanMode so the helper
  // does not re-fire flushPendingPlanExit on the next onAfterTurn. The
  // `closureSummarySkipped` option tells togglePlanMode to emit the
  // distinguishing OFF copy.
  ctx.stats.pendingPlanExit = false;
  await togglePlanMode(ctx, false, { closureSummarySkipped: true });
  return 'continue';
}

async function cancelPendingExit(ctx: SlashContext): Promise<SlashResult> {
  ctx.stats.pendingPlanExit = false;
  ctx.ui.repaintStatusLine();
  ctx.out.success(
    palette.warning('● plan mode ON') +
    palette.dim(' — plan exit cancelled, staying in plan mode.'),
  );
  return 'continue';
}

/**
 * Reached when the user submits `/plan <free text>` while a closure
 * exit is pending. Their new prompt replaces the queued closure summary
 * — emit a one-liner so the swap is visible.
 */
function noteFreeTextCancelledRitual(ctx: SlashContext): void {
  ctx.out.info(
    palette.dim('(plan exit cancelled — submitting your prompt instead.)'),
  );
}

export const planCmd: SlashCommand = {
  name: '/plan',
  usage: '/plan [on|off|<prompt>]',
  summary: 'Toggle plan mode (write_file, edit_file, and write-intent bash refused)',
  hint: 'When you want the model to think through an approach without touching files — refuses writes until you flip back. Shift+Tab toggles too.',
  async handler(ctx, args): Promise<SlashResult> {
    const arg = args.trim();
    const argLower = arg.toLowerCase();

    // Free-text arg: enter plan mode unconditionally and submit as prompt.
    if (arg !== '' && argLower !== 'on' && argLower !== 'off') {
      const wasPending = !!ctx.stats.pendingPlanExit;
      if (!ctx.stats.planMode) {
        await togglePlanMode(ctx, true);
      }
      // Re-engaging planning via free-text mid-ritual cancels the pending
      // exit — user is asking for more planning, not closure. Surface the
      // swap so the user does not think their new prompt is being queued
      // *after* a closure turn.
      if (wasPending) {
        ctx.stats.pendingPlanExit = false;
        noteFreeTextCancelledRitual(ctx);
      }
      return { kind: 'submit', message: arg };
    }

    const desired =
      argLower === 'on' ? true :
      argLower === 'off' ? false :
      !ctx.stats.planMode;

    if (desired === true) {
      if (ctx.stats.pendingPlanExit) return cancelPendingExit(ctx);
      if (ctx.stats.planMode) {
        // Already on, no pending exit — nothing to do. togglePlanMode would
        // emit a no-op success line; suppress it for ergonomics.
        return 'continue';
      }
      await togglePlanMode(ctx, true);
      return 'continue';
    }

    // desired === false
    if (!ctx.stats.planMode) {
      // Already off — toggle to make the message explicit (no-op effect on
      // the gate but the user sees the affordance).
      await togglePlanMode(ctx, false);
      return 'continue';
    }
    if (ctx.stats.pendingPlanExit) return forceExit(ctx);
    return startClosureRitual(ctx);
  },
};
