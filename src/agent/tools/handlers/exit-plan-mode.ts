/**
 * `exit_plan_mode` tool — schema + handler factory.
 *
 * The model-proposed counterpart to the `/plan off` slash command. When the
 * model judges its plan ready, it calls `exit_plan_mode`; the handler runs an
 * elicitation picker so the USER chooses how to proceed:
 *   - approve → implement in `default` mode (writes with path containment + prompts)
 *   - approve → implement in `bypassPermissions` mode (no prompts, read/write anywhere)
 *   - keep planning (stay in plan; refine)
 *
 * On approval the handler (a) flips the live permission mode via the injected
 * {@link PlanExitControls.setPermissionMode} and (b) queues the SAME crafted
 * implement-turn `/plan off` uses ({@link buildPlanExitPrompt}) via
 * {@link PlanExitControls.requestImplementSeed}. The REPL drains that seed after
 * the current turn (`src/cli/commands/interactive/loop-iteration.ts`) and
 * auto-submits it — so the model receives an explicit, high-quality
 * save-and-implement instruction rather than self-directing from a tool string.
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
import type { ElicitationRequest } from '../../types/sdk-types.js';
import { elicitationRouter } from '../../elicitation-router.js';
import { buildPlanExitPrompt } from '../../plan-mode-exit-prompt.js';
import { getProjectPlansDir } from '../../../paths.js';

/** Stable tool name — must be present in the session's tool allowlist. */
export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode';

// Choice labels. Kept clean ASCII < 128 chars so the REPL picker's
// `sanitizeSchemaString` is a no-op and `content.value` round-trips verbatim.
const CHOICE_DEFAULT = 'Approve — implement now (default mode: writes ask for confirmation, contained to the workspace)';
const CHOICE_BYPASS = 'Approve — implement now (bypass mode: no prompts, read/write any path)';
const CHOICE_KEEP = 'Keep planning';

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
 */
export function createExitPlanModeHandler(controls: PlanExitControls): ToolHandler {
  return async (_input, signal, context) => {
    const request: ElicitationRequest = {
      serverName: 'agent',
      origin: 'agent',
      type: 'choice',
      message:
        'Plan ready. How do you want to proceed? ' +
        '(Your plan is in the conversation above.)',
      choices: [CHOICE_DEFAULT, CHOICE_BYPASS, CHOICE_KEEP],
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
    // round-tripping. Order matters: detect "keep" first, then the dangerous
    // "bypass" branch, else the default-mode approval.
    if (picked.startsWith('Keep') || picked === CHOICE_KEEP) {
      return {
        content:
          'User chose to keep planning. Stay in plan mode and refine the plan; ' +
          'do not implement. Call exit_plan_mode again when ready.',
      };
    }

    const mode = picked.includes('bypass') ? 'bypassPermissions' : 'default';

    // Flip the live permission mode so the seeded implement-turn (next turn)
    // runs with writes permitted. Surfaced as a tool error only if the flip
    // itself rejects — without it, the seeded turn would collect gate refusals.
    try {
      await controls.setPermissionMode(mode);
    } catch (err) {
      return {
        content: `Could not exit plan mode: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    // Queue the SAME crafted save-and-implement turn `/plan off` seeds. The REPL
    // drains it after this turn and auto-submits it as a fresh user message.
    const plansDir = getProjectPlansDir(context?.resolveBase ?? context?.cwd ?? process.cwd());
    controls.requestImplementSeed(buildPlanExitPrompt(plansDir));

    return {
      content:
        `Plan approved (mode=${mode}). The implementation instruction will follow ` +
        'as a new message — end your turn now.',
    };
  };
}
