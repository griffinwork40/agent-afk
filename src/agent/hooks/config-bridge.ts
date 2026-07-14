/**
 * Bridge between loaded hook config and the live {@link HookRegistry}.
 *
 * `loadAndRegisterConfigHooks` constructs synthetic {@link HookHandler}
 * closures for every hook group in the resolved config and registers them
 * with the registry.  The trust gate (`userGlobalEnabled`) is checked first;
 * if it is false, no handlers are registered and a warning naming the skipped
 * hooks is emitted.
 *
 * A handler registered here for `'Stop'` inherits the harness `Stop` →
 * next-turn `injectContext` delivery documented in `../hooks.js`: a `Stop`
 * shell hook's `hookSpecificOutput.additionalContext` (mapped in
 * `./command-executor.js`) is prepended to the *next* turn's prompt by the
 * REPL loop. Pre-existing primitive, gated by the trust check above — not a
 * new trust boundary.
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
 * Two independent trust tiers:
 *  - Non-plugin hooks (user-global / project-local, `tier !== 'plugin'`) are
 *    gated behind `hookConfig.userGlobalEnabled` (`enableShellHooks`). When it
 *    is false they are skipped and a `console.warn` lists them so the user can
 *    diagnose why their `afk.config.json` hooks are not running.
 *  - Plugin hooks (`tier === 'plugin'`) are pre-filtered by the loader —
 *    present only when `enablePluginHooks` is set — and register regardless of
 *    `enableShellHooks`, since they are a distinct third-party trust decision.
 */
export function loadAndRegisterConfigHooks(
  registry: HookRegistry,
  hookConfig: LoadedHooksConfig,
  agentConfig: AgentConfigForBridge,
): void {
  const agentCwd = agentConfig.cwd ?? process.cwd();
  const sessionId = agentConfig.sessionId;
  const userGlobalEnabled = hookConfig.userGlobalEnabled;

  const validEvents: HarnessHookEvent[] = [
    'SessionStart',
    'SessionEnd',
    'SubagentStart',
    'SubagentStop',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostToolUseFailure',
    'Stop',
    'UserPromptSubmit',
  ];

  // When shell hooks are disabled, warn about the skipped NON-plugin hooks so
  // the user can diagnose why their afk.config.json hooks are not running.
  // Plugin hooks (tier 'plugin') still register below and are never "skipped"
  // here — they cleared their own enablePluginHooks gate in the loader.
  if (!userGlobalEnabled) {
    const skipped: string[] = [];
    for (const event of validEvents) {
      const groups = hookConfig.hooks[event];
      if (groups === undefined) continue;
      for (const group of groups) {
        if (group.tier === 'plugin') continue;
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
  }

  for (const event of validEvents) {
    const groups = hookConfig.hooks[event];
    if (groups === undefined || groups.length === 0) continue;

    for (const group of groups) {
      // Skip non-plugin groups when shell hooks are disabled. Plugin groups
      // register regardless — their enablePluginHooks gate was enforced by the
      // loader, which only emits plugin-tier groups when it is set.
      if (group.tier !== 'plugin' && !userGlobalEnabled) continue;

      // Compile the matcher once per group — not per dispatch.
      const matchFn = compileMatcher(group.matcher);

      for (const hook of group.hooks) {
        const hookCommand = hook.command;
        const hookTimeoutMs = hook.timeoutMs;
        const hookPluginRoot = hook.pluginRoot;

        const handler = async (context: HookContext): Promise<HookDecision> => {
          // For tool-scoped events, check the matcher against the tool name.
          if (
            context.event === 'PreToolUse' ||
            context.event === 'PostToolUse' ||
            context.event === 'PostToolUseFailure'
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
            ...(hookPluginRoot !== undefined ? { pluginRoot: hookPluginRoot } : {}),
          });

          return result.decision;
        };

        registry.register(event, handler);
      }
    }
  }
}
