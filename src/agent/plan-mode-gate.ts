/**
 * Plan-mode gate hook factory.
 *
 * Returns a `HookHandler` that blocks state-mutating tool calls when the session
 * is in 'plan' mode. The handler reads the current mode at call time (not at
 * construction time), so toggling the mode mid-session is reflected immediately
 * without reconstructing the registry.
 *
 * Blocked operations:
 *   - Any tool categorized as `'write'` by `tool-category.ts` — always blocked
 *     in plan mode. Covers `write_file`, `edit_file`, `memory_update`,
 *     `procedure_write`, `config_set`, and `terminal_font_size`: the tools that
 *     persist state to disk or memory. This is the meaningful, non-bypassable
 *     no-mutation guarantee.
 *   - `bash` — blocked when `classifyBashCommand` (`tools/readonly-bash.ts`)
 *     judges the command state-mutating; read-only recon (`git status/log/diff`,
 *     `ls`, `cat`, `grep`, `find`, and chains thereof) passes through. This is
 *     the SAME best-effort classifier that gates read-only skill phases (the
 *     dispatcher's `readOnlyBash` path), so the mutation rules live in one place
 *     and the two consumers cannot drift apart.
 *
 * The bash check is an honesty guardrail, NOT a security boundary. Because bash
 * is Turing-complete, no classifier is exhaustive — obfuscated writes
 * (`eval "$(printf …)"`, `sh -c "…"`) slip through, as `readonly-bash.ts` itself
 * documents. It catches the mutation shapes a cooperative model naturally emits
 * while planning and surfaces refusal so the user can `/plan off` rather than
 * silently allow the side-effect.
 *
 * @module agent/plan-mode-gate
 */

import type { HookContext, HookDecision } from './hooks.js';
import type { PermissionMode } from './types/sdk-types.js';
import { categorizeTool } from './tool-category.js';
import { classifyBashCommand } from './tools/readonly-bash.js';

export function createPlanModeGate(
  getMode: () => PermissionMode,
): (context: HookContext) => HookDecision {
  return function planModeGate(context: HookContext): HookDecision {
    if (context.event !== 'PreToolUse') return {};
    // Subagent guard: plan mode is a main-session conversation affordance —
    // the user is planning, not executing. A forked subagent is an isolated
    // worker whose tool calls (incl. writes to its own worktree) are task
    // output, not main-conversation mutations. It inherits the parent's
    // registry, so without this guard it would be plan-gated too. Skip it.
    if (context.parentSessionId) return {};
    if (getMode() !== 'plan') return {};

    const { toolName } = context;

    // External constraint (semantic invariant): any tool categorized as 'write'
    // persists state to disk or memory. Block all of them — write_file,
    // edit_file, memory_update, procedure_write, config_set, terminal_font_size.
    if (categorizeTool(toolName) === 'write') {
      return {
        decision: 'block',
        reason: `plan mode: ${toolName} is refused. Use /plan off to exit plan mode.`,
      };
    }

    // `bash` is mutation-gated, not blanket-refused: read-only recon runs,
    // state-mutating commands are refused. Reuses the same best-effort
    // classifier as the read-only skill phases (single source of mutation
    // rules). Best-effort, not a sandbox — see the module header.
    if (toolName === 'bash') {
      const cmd =
        typeof context.input === 'object' && context.input !== null
          ? String((context.input as Record<string, unknown>)['command'] ?? '')
          : '';
      const verdict = classifyBashCommand(cmd);
      if (verdict.mutating) {
        return {
          decision: 'block',
          reason:
            `plan mode: bash refused — command looks state-mutating ` +
            `(${verdict.reason ?? 'mutation detected'}). Read-only investigation ` +
            `(git status/log/diff, ls, cat, grep, find) is allowed. Use /plan off to act.`,
        };
      }
    }

    return {};
  };
}
