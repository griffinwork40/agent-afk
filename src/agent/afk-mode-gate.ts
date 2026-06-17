/**
 * AFK-mode gate hook factory.
 *
 * Returns a `HookHandler` that blocks high-risk / irreversible tool calls when
 * the session is in `'autonomous'` (AFK) mode. The handler reads the current
 * mode at call time (not at construction time), so toggling the mode
 * mid-session is reflected immediately without reconstructing the registry.
 *
 * Why a mechanical gate at all: AFK mode raises the agent's autonomy precisely
 * when no human is watching. The posture addendum
 * ({@link module:agent/providers/anthropic-direct/afk-mode-addendum}) asks the
 * model to stop at one-way doors, but posture text is not a safety mechanism.
 * This gate is the enforcement half — it refuses the irreversible/destructive
 * operations that must never run unattended on a model's say-so.
 *
 * Policy: the single source of truth for "how dangerous is this op" is
 * {@link classifyRisk} (`risk-classifier.ts`) — the same taxonomy the status
 * line and audit log use. AFK mode blocks anything it rates `'high'`:
 *   - destructive/irreversible bash (`rm`, `sudo`, `git push --force`,
 *     `git reset --hard`, `mkfs`/`dd`/`diskutil`, pipe-to-shell, `eval`,
 *     `chmod`/`chown`)
 *   - writes that escape the workspace, hit the write-denylist (`~/.ssh`,
 *     `/etc`, …), or target the `.git` object store
 * `'medium'` ops (normal `git push`/`git commit`, installs, builds, file moves)
 * and `'safe'` ops (reads, tests, lint) are ALLOWED — autonomous work has to be
 * useful, and these are reversible enough to run unattended.
 *
 * `send_telegram` is ALWAYS exempt: it is the operator's channel in AFK mode,
 * and the posture explicitly relies on it to surface Asking states.
 *
 * Deliberate divergence from the plan-mode gate: this gate does NOT skip
 * forked subagents (`context.parentSessionId`). Plan mode is a main-session
 * conversation affordance, so its gate exempts subagents. AFK mode is a SAFETY
 * ceiling — an unwatched subagent running `rm -rf` is exactly the risk the gate
 * exists to stop — so the ceiling applies tree-wide. Medium ops (e.g. a skill's
 * worktree commit) stay allowed, so this does not break skill flows; only
 * high-risk ops are refused, in the parent and in every child alike.
 *
 * Like the plan-mode gate, the bash classification is a best-effort honesty
 * guardrail, not a sandbox: bash is Turing-complete, so obfuscated writes can
 * slip through. It catches the destructive shapes a cooperative model naturally
 * emits and surfaces refusal so the operator can take over.
 *
 * @module agent/afk-mode-gate
 */

import type { HookContext, HookDecision } from './hooks.js';
import type { PermissionMode } from './types/sdk-types.js';
import { classifyRisk } from './risk-classifier.js';

export function createAfkModeGate(
  getMode: () => PermissionMode,
  cwd?: string,
): (context: HookContext) => HookDecision {
  return function afkModeGate(context: HookContext): HookDecision {
    if (context.event !== 'PreToolUse') return {};
    // No subagent guard, on purpose: the safety ceiling applies tree-wide.
    if (getMode() !== 'autonomous') return {};

    const { toolName } = context;

    // The operator's channel is never blocked — the posture relies on it to
    // surface Asking states from an unattended run.
    if (toolName === 'send_telegram') return {};

    // Single source of truth for risk. `workspaceRoot` is set to the session
    // cwd so writes that escape it are flagged `high` (classifyRisk's workspace
    // boundary rule); falling back to process.cwd() when unknown.
    const root = cwd ?? process.cwd();
    const risk = classifyRisk(toolName, context.input, {
      cwd: root,
      workspaceRoot: root,
    });

    if (risk === 'high') {
      return {
        decision: 'block',
        reason:
          `AFK mode: ${toolName} is refused — this op is high-risk or ` +
          `irreversible, and AFK mode runs autonomously without a human ` +
          `watching. Push an Asking summary to Telegram (send_telegram) and ` +
          `stop, or have the operator run /afk off and take over.`,
      };
    }

    return {};
  };
}
