/**
 * `exit_plan_mode` tool — schema + handler factory.
 *
 * The model-proposed counterpart to the `/plan off` slash command. When the
 * model judges its plan ready, it calls `exit_plan_mode`; the handler runs an
 * elicitation picker so the USER chooses how to proceed:
 *   - approve → implement, RESTORING the mode the user was in before plan mode
 *     (default / bypass / acceptEdits / …), captured by `AgentSession` on the
 *     flip into plan and read here via `PlanExitControls.getPrePlanMode()`
 *   - approve → escalate to `bypassPermissions` (offered unless the restored
 *     mode is already bypass — that would be a redundant duplicate row)
 *   - keep planning (stay in plan; refine)
 *
 * On approval the handler records the approved mode ALONGSIDE the seed message
 * via {@link PlanExitControls.requestImplementSeed} — the mode flip is NOT
 * applied here. It is deferred to the post-turn drain boundary in the REPL loop
 * (`src/cli/commands/interactive/loop-iteration.ts`), where
 * `takePendingPlanExitSeed()` atomically applies the flip and promotes the seed.
 * This mirrors how `/plan off` works: the gate stays LOCKED in plan mode for the
 * entire current turn; it only opens for the clean, seeded implement-turn that
 * follows — closing the mid-turn TOCTOU window.
 *
 * The seeded implement-turn is the SAME crafted prompt {@link buildPlanExitPrompt}
 * produces — byte-identical to `/plan off`'s handoff.
 *
 * Invariant: the tool is offered ONLY while `permissionMode === 'plan'` (the
 * providers gate registration on that), and `PlanExitControls` is supplied only
 * for top-level sessions, so it never fires on subagent / non-interactive
 * surfaces. It is not in the `WRITE_TOOLS` set, so the plan-mode gate
 * (`src/agent/plan-mode-gate.ts`) passes it through automatically.
 *
 * Colocated (schema + handler) like the awareness tool
 * (`src/agent/awareness/tool.ts`) because the handler's contract is intrinsic
 * to the tool — it owns the picker wording and the approve→mode mapping.
 *
 * @module agent/tools/handlers/exit-plan-mode
 */

import type { AnthropicToolDef, ToolHandler } from '../types.js';
import type { PlanExitControls } from '../../types/config-types.js';
import type { ElicitationRequest, PermissionMode } from '../../types/sdk-types.js';
import { elicitationRouter } from '../../elicitation-router.js';
import { buildPlanExitPrompt } from '../../plan-mode-exit-prompt.js';
import { getProjectPlansDir } from '../../../paths.js';

/** Stable tool name — must be present in the session's tool allowlist. */
export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode';

// Choice labels. Kept < 128 chars so the REPL picker's `sanitizeSchemaString`
// is a no-op and `content.value` round-trips verbatim.
//
// Invariant: the result matcher keys off the substring "bypass" to map a pick to
// `bypassPermissions`. So `restoreChoiceLabel` MUST contain "bypass" only when
// the restored mode IS bypass, and the static escalation label below is the only
// other "bypass"-bearing choice — any other restore label must omit the word.
const CHOICE_BYPASS = 'Approve — implement now (bypass mode: no prompts, read/write any path)';
const CHOICE_KEEP = 'Keep planning';

/**
 * Label for the primary "approve and implement" choice, which restores the mode
 * the user was in BEFORE plan mode. The phrasing reflects the concrete restored
 * mode so the picker is honest about where you land. See the matcher invariant
 * above: only the bypass case may contain the substring "bypass".
 */
function restoreChoiceLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'bypassPermissions':
      return 'Approve — implement now (restore bypass mode: no prompts, read/write any path)';
    case 'acceptEdits':
      return 'Approve — implement now (restore accept-edits mode: edits auto-approved)';
    case 'dontAsk':
    case 'auto':
      return 'Approve — implement now (restore your previous mode: no approval prompts)';
    case 'default':
    case 'plan':
    case 'autonomous':
    default:
      return 'Approve — implement now (restore default mode: writes ask for confirmation, contained to the workspace)';
  }
}

/**
 * Tool definition for `exit_plan_mode`. Signal-only: no parameters — the plan
 * lives in the conversation, and the seeded implement-turn instructs the model
 * to write it to a file. The description carries the when-to-call contract;
 * `plan-mode-addendum.ts` reinforces it at turn start.
 */
export const exitPlanModeTool: AnthropicToolDef = {
  name: EXIT_PLAN_MODE_TOOL_NAME,
  category: 'other',
  concurrencySafe: false,
  description:
    'Signal that your plan is ready and present it to the user for approval. ' +
    'The user is shown a picker: approve and implement (you pick neither mode — ' +
    'the user does), or keep planning.\n\n' +
    'IMPORTANT: only call this in plan mode, and only when the task requires ' +
    'implementation (writing code or files). For research / read-only / ' +
    'understanding tasks, do NOT call it — just answer.\n\n' +
    'Do NOT ask "is this plan ok?" with ask_question — that is what this tool ' +
    'does. Resolve any open requirement questions with ask_question FIRST, then ' +
    'call exit_plan_mode.\n\n' +
    'After calling this tool, END YOUR TURN. On approval you will receive a ' +
    'separate instruction to save the plan and implement it — do not start ' +
    'implementing in the same turn.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * Factory producing a handler closed over the session's {@link PlanExitControls}.
 * Registered per-query by the providers' `buildDispatcher` while in plan mode.
 *
 * Security note: the handler does NOT flip the permission mode. It records the
 * approved mode alongside the seed via `controls.requestImplementSeed(msg, mode)`
 * and the flip is applied atomically at the post-turn drain boundary — so the
 * gate remains locked in plan mode for the rest of this turn.
 */
export function createExitPlanModeHandler(controls: PlanExitControls): ToolHandler {
  return async (_input, signal, context) => {
    // Restore the mode the user was in before plan mode (falls back to 'default'
    // when none was captured). This is the PRIMARY approve choice.
    const prevMode: PermissionMode = controls.getPrePlanMode() ?? 'default';
    const restoreChoice = restoreChoiceLabel(prevMode);

    // Offer an explicit bypass ESCALATION too — unless the restore choice is
    // already bypass (the user planned from bypass), in which case a second
    // bypass row would be redundant.
    const choices =
      prevMode === 'bypassPermissions'
        ? [restoreChoice, CHOICE_KEEP]
        : [restoreChoice, CHOICE_BYPASS, CHOICE_KEEP];

    const request: ElicitationRequest = {
      serverName: 'agent',
      origin: 'agent',
      type: 'choice',
      message:
        'Plan ready. How do you want to proceed? ' +
        '(Your plan is in the conversation above.)',
      choices,
    };

    const result = await elicitationRouter.route(request, { signal });

    // No human reachable (no handler) or the user interrupted → stay in plan
    // mode and let the model keep refining. Not an error: declining to exit is
    // a legitimate outcome, mirroring `/plan`'s no-op when already planning.
    if (result.action !== 'accept') {
      return {
        content:
          'Plan exit not confirmed (the user did not approve). Stay in plan mode — ' +
          'keep refining the plan; do not implement. Call exit_plan_mode again when ready.',
      };
    }

    const picked = typeof result.content?.['value'] === 'string'
      ? (result.content['value'] as string)
      : '';

    // Keyword matching is robust to picker sanitization / numbered-fallback
    // round-tripping. Order matters: detect "keep" first, then the "bypass"
    // branch (the escalation choice, or restore-of-bypass — both land in
    // bypass), else restore the captured pre-plan mode.
    if (picked.startsWith('Keep') || picked === CHOICE_KEEP) {
      return {
        content:
          'User chose to keep planning. Stay in plan mode and refine the plan; ' +
          'do not implement. Call exit_plan_mode again when ready.',
      };
    }

    const mode: PermissionMode = picked.includes('bypass') ? 'bypassPermissions' : prevMode;

    // Record the approved mode ALONGSIDE the seed. The permission flip is deferred
    // to the post-turn drain boundary (loop-iteration.ts → takePendingPlanExitSeed)
    // so the gate stays locked in plan mode for the remainder of this turn —
    // closing the mid-turn TOCTOU window where the model could issue write tools
    // in bypass mode before actually ending its turn.
    const plansDir = getProjectPlansDir(context?.resolveBase ?? context?.cwd ?? process.cwd());
    controls.requestImplementSeed(buildPlanExitPrompt(plansDir), mode);

    return {
      content:
        `Plan approved (mode=${mode}). The implementation instruction will follow ` +
        'as a new message — end your turn now.',
    };
  };
}
