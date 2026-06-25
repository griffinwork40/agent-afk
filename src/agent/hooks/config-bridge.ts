/**
 * Bridge between loaded hook config and the live {@link HookRegistry}.
 *
 * `loadAndRegisterConfigHooks` constructs synthetic {@link HookHandler}
 * closures for every hook group in the resolved config and registers them
 * with the registry.  The trust gate (`userGlobalEnabled`) is checked first;
 * if it is false, no handlers are registered and a warning naming the skipped
 * hooks is emitted.
 *
 * @module agent/hooks/config-bridge
 */

import type { HookRegistry, HookContext, HookDecision, HarnessHookEvent } from '../hooks.js';
import type { LoadedHooksConfig } from './config-loader.js';
import { compileMatcher } from './config-loader.js';
import { executeCommand } from './command-executor.js';

export interface AgentConfigForBridge {
  cwd?: string;
  sessionId?: string;
}

/**
 * Register all config-driven shell hooks with `registry`.
 *
 * Returns without registering if `hookConfig.userGlobalEnabled` is false —
 * a `console.warn` lists all skipped hooks so the user can diagnose why their
 * hooks are not running.
 */
export function loadAndRegisterConfigHooks(
  registry: HookRegistry,
  hookConfig: LoadedHooksConfig,
  agentConfig: AgentConfigForBridge,
): void {
  if (!hookConfig.userGlobalEnabled) {
    // Collect skipped hook descriptions for the warning.
    const skipped: string[] = [];
    for (const event of Object.keys(hookConfig.hooks) as HarnessHookEvent[]) {
      const groups = hookConfig.hooks[event];
      if (groups === undefined) continue;
      for (const group of groups) {
        for (const hook of group.hooks) {
          skipped.push(`${event}: ${hook.command}`);
        }
      }
    }
    if (skipped.length > 0) {
      console.warn(
        `[hooks] shell hooks are disabled (enableShellHooks not set in user-global config).\n` +
          `Skipped ${skipped.length} hook(s):\n` +
          skipped.map((s) => `  - ${s}`).join('\n'),
      );
    }
    return;
  }

  const agentCwd = agentConfig.cwd ?? process.cwd();
  const sessionId = agentConfig.sessionId;

  const validEvents: HarnessHookEvent[] = [
    'SessionStart',
    'SessionEnd',
    'SubagentStart',
    'SubagentStop',
    'PreToolUse',
    'PostToolUse',
    'Stop',
  ];

  for (const event of validEvents) {
    const groups = hookConfig.hooks[event];
    if (groups === undefined || groups.length === 0) continue;

    for (const group of groups) {
      // Compile the matcher once per group — not per dispatch.
      const matchFn = compileMatcher(group.matcher);

      for (const hook of group.hooks) {
        const hookCommand = hook.command;
        const hookTimeoutMs = hook.timeoutMs;

        const handler = async (context: HookContext): Promise<HookDecision> => {
          // For tool-scoped events, check the matcher against the tool name.
          if (
            context.event === 'PreToolUse' ||
            context.event === 'PostToolUse'
          ) {
            if (!matchFn(context.toolName)) {
              return {};
            }
          }

          const result = await executeCommand({
            command: hookCommand,
            context,
            agentCwd,
            sessionId,
            timeoutMs: hookTimeoutMs,
          });

          return result.decision;
        };

        registry.register(event, handler);
      }
    }
  }
}
