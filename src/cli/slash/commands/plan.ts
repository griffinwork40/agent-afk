/**
 * /plan — toggle plan mode, and on exit save the plan + implement it.
 *
 * Usage:
 *   /plan                    — toggle plan mode on/off
 *   /plan on                 — enter plan mode
 *   /plan off                — exit plan mode, then save the plan to a file
 *                              and implement it (see "Exit behavior" below)
 *   /plan <free text>        — enter plan mode and pre-fill the prompt with
 *                              <free text> for immediate submission
 *
 * Enforcement: in plan mode, write_file, edit_file, memory_update, and
 * procedure_write are refused by the plan-mode gate hook
 * (`src/agent/plan-mode-gate.ts`). `bash` is mutation-gated rather than blanket-
 * refused: read-only recon (git status/log/diff, ls, cat, grep, find) runs,
 * while state-mutating commands are refused via the shared `classifyBashCommand`
 * classifier (best-effort, not a security boundary — the same classifier that
 * gates read-only skill phases). This is hook-level refusal in agent-afk's own
 * harness — the model is not lied to about which permission mode it is in, and
 * there is no upstream permission-mode layer being relied on. (agent-afk talks
 * to the Anthropic Messages API directly via `@anthropic-ai/sdk`; it does not
 * use `@anthropic-ai/claude-agent-sdk`.)
 *
 * Posture: the `anthropic-direct` provider appends a planning-topology
 * addendum to the system prompt whenever permissionMode === 'plan', so the
 * model sees plan mode at turn start and knows which skills match each step
 * of the shape.
 *
 * Exit behavior (`/plan off`, or bare `/plan` while in plan mode):
 *   1. Flip the session to `default` mode IMMEDIATELY. This is the critical
 *      ordering: the flip happens BEFORE the next turn so that turn runs with
 *      writes permitted and without the plan-mode addendum. (The prior design
 *      deferred the flip to keep writes refused through a closure-summary
 *      turn; the new design needs the opposite — the model must write the
 *      plan file and then act on it.)
 *   2. Seed a `{ kind: 'submit' }` turn whose prompt tells the model: the user
 *      has exited plan mode, save the plan you developed to a markdown file
 *      under `<cwd>/.afk/plans/`, then implement it. The REPL auto-submits the
 *      seeded message on the next loop iteration; that turn runs in `default`
 *      mode, so the writes land.
 *
 * If the flip fails (a transient `setPermissionMode` rejection — surfaced by
 * `togglePlanMode`, which leaves `permissionMode` unchanged), no implement turn is
 * seeded: seeding one while writes are still refused would only produce a
 * wall of gate refusals.
 *
 * Escape hatch: Shift+Tab from the REPL advances the permission-mode ring
 * (default → plan → bypass) with no seeded turn — it does NOT save or implement.
 * From plan mode it steps to bypass; use it to drop planning and take manual
 * control. (Cycle lives in `permission-mode-cycle.ts`.)
 *
 * Scope: plan mode is a REPL-only conversation affordance. Other surfaces
 * (Telegram) never enter plan mode (their sessions are constructed with
 * `permissionMode: 'default'` and no toggle path), so this command's exit behavior is
 * exercised only by the REPL's `{ kind: 'submit' }` consumer.
 */

import { getProjectPlansDir } from '../../../paths.js';
import { togglePlanMode } from '../../plan-mode-toggle.js';
import { palette } from '../../palette.js';
import type { SlashCommand, SlashContext, SlashResult } from '../types.js';

/**
 * Build the prompt seeded into the user's next message buffer when plan mode
 * is exited via `/plan off`. `plansDir` is an absolute path to the session's
 * `<cwd>/.afk/plans/` directory; the model picks a descriptive filename within
 * it (the `write_file` tool creates the directory if absent).
 */
export function buildPlanExitPrompt(plansDir: string): string {
  return [
    'The user has switched off plan mode. Writes are now permitted. Do two things, in order:',
    '',
    `1. Save the plan. Write the plan you developed in this conversation to a new markdown file under \`${plansDir}/\` — pick a short, descriptive kebab-case filename (e.g. \`${plansDir}/refactor-auth-flow.md\`). Capture the full plan: the chosen approach, the concrete step-by-step changes, the risks named, and the alternatives considered. This is the durable record.`,
    '',
    '2. Implement the plan. Work through the steps you just recorded, verifying as you go — run the project\'s lint/test gates where they apply. End in a terminal state: Done with evidence, Blocked with the exact unblock condition, or Asking one precise question.',
  ].join('\n');
}

/**
 * Exit plan mode and seed the save-and-implement turn. Flips to `default`
 * FIRST (so the seeded turn runs unrestricted), then returns the submit
 * result. On flip failure, returns `'continue'` without seeding a turn.
 */
async function exitAndImplement(ctx: SlashContext): Promise<SlashResult> {
  await togglePlanMode(ctx, false);
  if (ctx.stats.permissionMode === 'plan') {
    // Flip failed — togglePlanMode already surfaced the error and left
    // permissionMode unchanged. Do NOT seed an implement turn while writes are
    // still refused; the model would only collect gate refusals.
    return 'continue';
  }
  const plansDir = getProjectPlansDir(ctx.stats.cwd ?? process.cwd());
  ctx.out.info(
    palette.dim(`  → saving the plan to ${plansDir}/, then implementing it.`),
  );
  return { kind: 'submit', message: buildPlanExitPrompt(plansDir) };
}

export const planCmd: SlashCommand = {
  name: '/plan',
  usage: '/plan [on|off|<prompt>]',
  summary: 'Toggle plan mode; /plan off saves the plan to a file then implements it',
  hint: 'Think through an approach without changing anything — write tools and state-mutating bash are refused until you exit; read-only investigation runs. /plan off saves the plan + implements it; Shift+Tab cycles to the next mode without implementing.',
  async handler(ctx, args): Promise<SlashResult> {
    const arg = args.trim();
    const argLower = arg.toLowerCase();

    // Free-text arg: enter plan mode unconditionally and submit as prompt.
    if (arg !== '' && argLower !== 'on' && argLower !== 'off') {
      if (ctx.stats.permissionMode !== 'plan') {
        await togglePlanMode(ctx, true);
      }
      return { kind: 'submit', message: arg };
    }

    const desired =
      argLower === 'on' ? true :
      argLower === 'off' ? false :
      ctx.stats.permissionMode !== 'plan';

    if (desired === true) {
      if (ctx.stats.permissionMode === 'plan') {
        // Already on — nothing to do. togglePlanMode would emit a no-op
        // success line; suppress it for ergonomics.
        return 'continue';
      }
      await togglePlanMode(ctx, true);
      return 'continue';
    }

    // desired === false
    if (ctx.stats.permissionMode !== 'plan') {
      // Already off — toggle to surface the affordance (no-op on the gate).
      // No plan to save, so no implement turn is seeded.
      await togglePlanMode(ctx, false);
      return 'continue';
    }
    return exitAndImplement(ctx);
  },
};
