/**
 * Plan-mode gate hook factory.
 *
 * Returns a `HookHandler` that blocks write-class tool calls when the session
 * is in 'plan' mode. The handler reads the current mode at call time (not at
 * construction time), so toggling the mode mid-session is reflected immediately
 * without reconstructing the registry.
 *
 * Blocked operations:
 *   - Any tool categorized as `'write'` by `tool-category.ts` — always blocked
 *     in plan mode. This covers `write_file`, `edit_file`, `memory_update`, and
 *     `procedure_write` (the last two previously fell through and allowed plan
 *     mode to mutate persistent memory — now fixed).
 *   - `bash` — blocked when the command matches a write-intent denylist.
 *     Unknown/read-only bash commands pass through.
 *
 * This gate is a best-effort honesty primitive, not a security boundary.
 * Interpreter-mediated writes (`python -c`, `node -e`, `curl -o`, `wget -O`,
 * heredocs, `dd`, `truncate`, etc.) are not caught. The denylist is
 * substring-matched against the raw command string and is intentionally
 * conservative: it catches the common write-intent shapes a model would
 * naturally emit in plan mode, and surfaces refusal so the user can choose
 * to exit plan mode rather than silently allowing the side-effect.
 *
 * @module agent/plan-mode-gate
 */

import type { HookContext, HookDecision } from './hooks.js';
import type { PermissionMode } from './types/sdk-types.js';
import { categorizeTool } from './tool-category.js';

const BASH_DENYLIST = [
  'git commit',
  'git push',
  'git reset',
  'rm ',
  'mv ',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'cp ',
  'tee ',
  ' > ',
  ' >> ',
  'npm install',
  'pnpm install',
  'pip install',
  'apt ',
  'apt-get ',
  'brew install',
  ' && ',
];

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
    // persists state to disk. Block all of them, not just file-write tools.
    // Previously only write_file and edit_file were blocked; memory_update and
    // procedure_write now blocked too (bug fix — plan mode must not allow
    // persistent-memory mutation).
    if (categorizeTool(toolName) === 'write') {
      return {
        decision: 'block',
        reason: `plan mode: ${toolName} is refused. Use /plan off to exit plan mode.`,
      };
    }

    if (toolName === 'bash') {
      const cmd =
        typeof context.input === 'object' && context.input !== null
          ? String((context.input as Record<string, unknown>)['command'] ?? '')
          : '';
      const denied = BASH_DENYLIST.some((p) => cmd.includes(p));
      if (denied) {
        return {
          decision: 'block',
          reason:
            'plan mode: write-intent bash is refused. Use /plan off or rephrase as a read-only command.',
        };
      }
    }

    return {};
  };
}
