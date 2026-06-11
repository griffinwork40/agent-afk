/**
 * Plan-mode system-prompt addendum.
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
 * @module agent/providers/anthropic-direct/plan-mode-addendum
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

export const PLAN_MODE_ADDENDUM_TEXT = [
  '## Plan mode is active',
  '',
  'Write-class tools (`write_file`, `edit_file`, write-intent `bash`) are refused at the hook layer.',
  'The user has asked you to plan, not yet to act. Treat this turn as planning work.',
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
  'Do not declare readiness silently. When the plan is ready, state: chosen approach, risks named, and alternatives considered. The user will then exit plan mode with `/plan off`, which has you save this plan to a file and implement it (Shift+Tab exits without implementing) — so keep the plan concrete and complete enough to act on directly.',
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
