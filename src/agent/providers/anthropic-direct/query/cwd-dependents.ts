/**
 * Cwd-dependent query rebuild helpers for {@link AnthropicDirectProvider.query}.
 *
 * The returned factory rebuilds the cwd-sensitive system prompt fragment and
 * tool dispatcher when setCwd() is called mid-session. Shared root arrays are
 * mutated in place, never snapshot-copied, preserving by-reference grant state
 * across old and new dispatchers.
 *
 * @module agent/providers/anthropic-direct/query/cwd-dependents
 */

import type { AgentConfig } from '../../../types/config-types.js';
import type { SubagentExecutor } from '../../../tools/subagent-executor.js';
import type { SkillExecutor } from '../../../tools/skill-executor.js';
import type { ComposeExecutor } from '../../../tools/compose-executor.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';
import { formatEnvironmentFragment, type RuntimeStateSource } from '../../../awareness/index.js';

export type CwdDependentsFactory = (newCwd: string) => {
  userSystem: string;
  dispatcher: ToolDispatcher;
};

export interface CwdDependentsFactoryArgs {
  stableSystemPrefix: string[];
  config: AgentConfig;
  surface: string;
  runtimeStateSource: RuntimeStateSource;
  getCurrentCwd: () => string | undefined;
  setCurrentCwd: (cwd: string) => void;
  getCurrentPermissionMode: () => string;
  sharedReadRoots: string[] | undefined;
  sharedWriteRoots: string[] | undefined;
  subagentExecutor: SubagentExecutor | undefined;
  skillExecutor: SkillExecutor | undefined;
  composeExecutor: ComposeExecutor | undefined;
  buildDispatcher: (permissionMode: string, opts: {
    cwd?: string;
    env?: Record<string, string>;
    readRoots?: string[];
    writeRoots?: string[];
    sessionId?: string;
    parentSessionId?: string;
    traceWriter?: AgentConfig['traceWriter'];
    runtimeStateSource?: RuntimeStateSource;
    hookRegistry?: AgentConfig['hookRegistry'];
    planExitControls?: AgentConfig['planExitControls'];
  }) => ToolDispatcher;
}

/** Build the cwdDependentsFactory passed to AnthropicDirectQuery. */
export function createCwdDependentsFactory(args: CwdDependentsFactoryArgs): CwdDependentsFactory {
  return (newCwd: string): { userSystem: string; dispatcher: ToolDispatcher } => {
    // 1. In-place migration of shared roots: swap `oldCwd → newCwd` so
    //    /allow-dir grants accumulated during the old-cwd window survive
    //    intact, and so all dispatchers sharing these arrays see the
    //    new path immediately.
    const oldCwd = args.getCurrentCwd();
    if (args.sharedReadRoots && oldCwd !== undefined && oldCwd !== newCwd) {
      const rIdx = args.sharedReadRoots.indexOf(oldCwd);
      if (rIdx !== -1) {
        args.sharedReadRoots[rIdx] = newCwd;
      } else if (!args.sharedReadRoots.includes(newCwd)) {
        args.sharedReadRoots.push(newCwd);
      }
    }
    if (args.sharedWriteRoots && oldCwd !== undefined && oldCwd !== newCwd) {
      const wIdx = args.sharedWriteRoots.indexOf(oldCwd);
      if (wIdx !== -1) {
        args.sharedWriteRoots[wIdx] = newCwd;
      } else if (!args.sharedWriteRoots.includes(newCwd)) {
        args.sharedWriteRoots.push(newCwd);
      }
    }
    args.setCurrentCwd(newCwd);

    // 1b. Re-anchor the forked sub-agent / skill / compose executors so
    //     child tool calls (the `agent`, skill, and compose tools) land in
    //     the new worktree instead of the host's process.cwd(). Without
    //     this, a born-named `afk -w` worktree leaves the executors frozen
    //     on the launch dir.
    args.subagentExecutor?.setCwd(newCwd);
    args.skillExecutor?.setCwd(newCwd);
    args.composeExecutor?.setCwd(newCwd);

    // 2. Rebuild system-prompt fragment with the new `# Environment` line.
    //    Build a fresh copy each invocation — splice mutates in place.
    //    Awareness identity fields (sessionId/surface/depth/maxDepth)
    //    are stable across cwd swaps, so we reuse the config snapshot.
    const newSystemParts = [
      args.stableSystemPrefix[0]!,
      args.stableSystemPrefix[1]!,
      formatEnvironmentFragment({
        cwd: newCwd,
        ...(args.config.sessionId !== undefined ? { sessionId: args.config.sessionId } : {}),
        surface: args.surface,
        ...(args.config.depth !== undefined ? { depth: args.config.depth } : {}),
        ...(args.config.maxDepth !== undefined ? { maxDepth: args.config.maxDepth } : {}),
        // Workspace is stable across cwd swaps (captured at session start).
        workspace: args.runtimeStateSource.getWorkspace(),
      }),
      ...args.stableSystemPrefix.slice(2),
    ];
    const newUserSystem = newSystemParts.join('\n\n');

    // 3. Build the new dispatcher. Its bash/grep/glob handlers close over
    //    `newCwd` so future fall-through reads (where context is absent)
    //    use the new path. The shared root arrays are passed by reference
    //    so any future grant survives across both old and new dispatchers.
    //    The same `runtimeStateSource` from the outer query() scope is
    //    forwarded so the new dispatcher's handler map still contains
    //    `get_runtime_state`. The source's `getEnabledToolNames` closure
    //    will continue to reference the original `queryDispatcher` — an
    //    accepted minor staleness window for Phase 1 (worktree rename
    //    rarely coincides with mid-session MCP tool refresh).
    // Use the LIVE permission mode (not the captured construction-time
    // `permissionMode`) so a `/cd` after a `/bypass` toggle rebuilds the
    // dispatcher with the current allowAll, never reverting the toggle.
    const newDispatcher = args.buildDispatcher(args.getCurrentPermissionMode(), {
      cwd: newCwd,
      readRoots: args.sharedReadRoots,
      writeRoots: args.sharedWriteRoots,
      ...(args.config.env !== undefined ? { env: args.config.env } : {}),
      sessionId: args.config.sessionId,
      parentSessionId: args.config.parentSessionId,
      traceWriter: args.config.traceWriter,
      runtimeStateSource: args.runtimeStateSource,
      hookRegistry: args.config.hookRegistry,
      // Carry the resident plan-exit handler across a cwd rebuild — omitting
      // this previously dropped `exit_plan_mode` after a `/cd` while planning.
      planExitControls: args.config.planExitControls,
    });
    return { userSystem: newUserSystem, dispatcher: newDispatcher };
  };
}
