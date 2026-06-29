/**
 * Plan-mode system-prompt addendum — provider-neutral.
 *
 * When the session is in `'plan'` permission mode, this module supplies a
 * single text block that the provider's `composeSystem()` appends to the
 * system payload. The addendum is the *posture* half of plan mode — its
 * companion is the hook-layer refusal in {@link module:agent/plan-mode-gate}
 * which is the *enforcement* half.
 *
 * Design notes:
 *  - The text is intentionally short. It names the topology (ground → gather
 *    → reveal → pressure → embody) and the skill primitives that match each
 *    step. It does not script a sequence; the model chooses which steps the
 *    work needs.
 *  - The block carries no `cache_control` of its own — `withSystemBreakpoint`
 *    in `cache-policy.ts` floats the breakpoint to whichever block is last,
 *    so toggling plan mode busts the cache once (correct) and same-mode
 *    turns hit cleanly.
 *  - The skill names listed here MUST stay in sync with the bundled-plugin
 *    skills under `src/bundled-plugins/awa-bundled/skills/`. They are the
 *    skills the model can already invoke via the `skill` tool; the addendum
 *    just nominates the relevant subset for the planning topology.
 *
 * Previously located at `anthropic-direct/plan-mode-addendum.ts`. Moved here
 * because both the anthropic-direct and openai-compatible providers (and their
 * tests) consume these exports. The original file now re-exports from this
 * location so existing imports continue to resolve without change.
 *
 * @module agent/providers/shared/plan-mode-addendum
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

export const PLAN_MODE_ADDENDUM_TEXT = [
  '## Plan mode is active',
  '',
  'File and memory write tools (`write_file`, `edit_file`, `memory_update`, `procedure_write`) are refused at the hook layer.',
  '`bash` runs for read-only investigation (git status/log/diff, ls, cat, grep, find — chained or not); state-mutating bash (file writes, rm, installs, commits, pushes) is refused while planning. The user has asked you to plan, not yet to act — exit plan mode to make changes.',
  'Treat this turn as planning work.',
  '',
  'Traverse the shape that matches the work — skip steps the terrain already covers, do not skip steps the terrain hides:',
  '',
  '  unknown field → ground the current terrain → gather missing codebase context →',
  '  research missing external context → reveal chaos / constraints / risks →',
  '  name the failure geometry → form a candidate plan → apply adversarial pressure → embody the final plan',
  '',
  'Reach for these skills (invoke via the `skill` tool) when the cost of skipping exceeds the cost of dispatching:',
  '  - `ground-state` — survey git, infra, memory before non-trivial work',
  '  - `gather` — parallel context-gathering for a code area',
  '  - `research` — parallel external + local context for the current task',
  '  - `devils-advocate` — generate alternatives and rank them before committing',
  '  - `shadow-verify` — independently re-derive load-bearing claims',
  '',
  'Do not declare readiness silently. When the plan is ready, state: chosen approach, risks named, and alternatives considered.',
  '',
  'Then, IF the task requires implementation (writing code or files), call the `exit_plan_mode` tool to present your plan. The user picks how to proceed (approve and implement, or keep planning). After calling it, END YOUR TURN — on approval you will receive a separate instruction to save the plan to a file and implement it. Do NOT use `ask_question` to ask whether the plan is OK; that is exactly what `exit_plan_mode` does — use `ask_question` only to resolve open requirement questions first. For research / read-only tasks that need no code changes, do NOT call `exit_plan_mode` — just answer.',
  '',
  'Manual fallbacks remain: the user can exit with `/plan off` (same save-and-implement handoff), and Shift+Tab advances the permission-mode ring without saving or implementing. Keep the plan concrete and complete enough to act on directly.',
].join('\n');

/**
 * Returns the addendum block when the session is in `'plan'` mode, else
 * `null`. The block is a plain text content block with no `cache_control`
 * stamp (the breakpoint stamper handles cache markers).
 */
export function buildPlanModeAddendumBlock(
  mode: string | undefined,
): ContentBlockParam | null {
  if (mode !== 'plan') return null;
  return { type: 'text', text: PLAN_MODE_ADDENDUM_TEXT };
}
