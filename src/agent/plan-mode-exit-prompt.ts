/**
 * The crafted "save the plan, then implement it" turn used when a session
 * leaves plan mode.
 *
 * Invariant: this is the SINGLE source of truth for the plan-exit implement
 * prompt. Two call sites materialize it and MUST produce byte-identical text:
 *   - the `/plan off` slash command (`src/cli/slash/commands/plan.ts`), which
 *     seeds it as the next REPL user turn; and
 *   - the model-callable `exit_plan_mode` tool
 *     (`src/agent/tools/handlers/exit-plan-mode.ts`), which seeds the same turn
 *     through the session→REPL seed bridge on user approval.
 *
 * Lives in the agent layer (not under `src/cli`) so the agent-layer tool
 * handler can import it without inverting the cli→agent dependency direction.
 * It depends only on a pre-resolved `plansDir` string, so it pulls in nothing
 * from either layer.
 *
 * @module agent/plan-mode-exit-prompt
 */

/**
 * Build the prompt seeded into the user's next message buffer when plan mode
 * is exited (via `/plan off` or an approved `exit_plan_mode`). `plansDir` is an
 * absolute path to the session's `<cwd>/.afk/plans/` directory; the model picks
 * a descriptive filename within it (the `write_file` tool creates the directory
 * if absent).
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
