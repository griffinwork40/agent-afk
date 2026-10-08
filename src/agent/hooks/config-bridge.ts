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
import { compileMatcher, isPluginHookDisabled } from './config-loader.js';
import { executeCommand } from './command-executor.js';
import { isWhatifEpisode, keepContextHooksInEpisode } from '../whatif-episode-gate.js';
import { resolveContextSessionId } from './hook-utils.js';
import { readIndex } from '../plugins/index-store.js';

export interface AgentConfigForBridge {
  cwd?: string;
  sessionId?: string;
  /**
   * Live getter for the current session's autosaved markdown transcript path.
   *
   * Called at hook-dispatch time (not registration time) so it reflects the
   * current path even after a `/clear` rotation. Returns `null` when no
   * transcript is available (daemon, `afk chat`, web, or REPL before the first
   * turn completes). The resolved value is forwarded as `transcript_path` in
   * the stdin payload sent to every shell hook command.
   *
   * Artifact chosen: `~/.afk/state/transcripts/<isoStamp>.md` — the REPL's
   * per-session autosaved markdown transcript. It is written incrementally as
   * turns complete, so it already contains prior conversation turns when any
   * hook fires. Format: markdown with `## User` / `## Assistant` blocks
   * separated by `---` dividers. A Claude-Code-compatible JSONL export is a
   * possible follow-up.
   */
  getTranscriptPath?: () => string | null;
}

/**
 * Warn about non-plugin hooks skipped because `enableShellHooks` is unset.
 * Extracted as a named helper (explicit params, no closure) to keep
 * `loadAndRegisterConfigHooks` under the 200-line function ceiling.
 */
function warnSkippedShellHooks(
  hookConfig: LoadedHooksConfig,
  validEvents: readonly HarnessHookEvent[],
): void {
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
  const getTranscriptPath = agentConfig.getTranscriptPath;
  const userGlobalEnabled = hookConfig.userGlobalEnabled;

  // Episode mode: disable the context-injecting events (SessionStart and
  // UserPromptSubmit) by default so both the baseline and candidate arms see
  // byte-identical first user messages.  Cwd- or recency-sensitive hooks
  // (e.g. a plugin hook whose output depends on cwd and accumulated state)
  // would otherwise inject arm-specific text that confounds every delta
  // measurement.
  //
  // Tool-gating hooks (PreToolUse, PostToolUse, PostToolUseFailure, Stop, …)
  // keep registering in episodes — they cannot inject context into the first
  // user message and their presence makes the episode more realistic.
  //
  // Setting AFK_WHATIF_KEEP_CONTEXT_HOOKS=1 (or auto-set by the harness when
  // the change spec itself targets hooks or plugins) restores pre-fix behaviour
  // so both arms can observe the hooks under test.
  const inEpisode = isWhatifEpisode();
  const keepContextHooks = keepContextHooksInEpisode();

  /** Events whose injectContext reaches the first user message of a session. */
  const CONTEXT_INJECTING_EVENTS: ReadonlySet<HarnessHookEvent> = new Set([
    'SessionStart',
    'UserPromptSubmit',
  ]);

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
    warnSkippedShellHooks(hookConfig, validEvents);
  }

  // In episode mode (without opt-in), skip the context-injecting events only
  // (SessionStart and UserPromptSubmit) and warn so the operator knows what
  // was disabled.  Tool-gating events are unaffected and register below.
  if (inEpisode && !keepContextHooks) {
    const disabledHooks: string[] = [];
    for (const event of CONTEXT_INJECTING_EVENTS) {
      const groups = hookConfig.hooks[event];
      if (groups === undefined) continue;
      for (const group of groups) {
        for (const hook of group.hooks) {
          disabledHooks.push(`${event}: ${hook.command}`);
        }
      }
    }
    if (disabledHooks.length > 0) {
      console.warn(
        `[hooks] what-if episode: SessionStart and UserPromptSubmit hooks disabled so both arms` +
          ` see identical first user messages (set AFK_WHATIF_KEEP_CONTEXT_HOOKS=1 to keep):\n` +
          disabledHooks.map((s) => `  - ${s}`).join('\n'),
      );
    }
    // Do NOT return here — tool-gating events (PreToolUse, PostToolUse, etc.)
    // still need to register to preserve episode realism.
  }

  for (const event of validEvents) {
    // Episode mode without opt-in: skip context-injecting events to keep arms
    // byte-identical on their first user message.
    if (inEpisode && !keepContextHooks && CONTEXT_INJECTING_EVENTS.has(event)) continue;

    const groups = hookConfig.hooks[event];
    if (groups === undefined || groups.length === 0) continue;

    for (const group of groups) {
      // Skip non-plugin groups when shell hooks are disabled. Plugin groups
      // register regardless — their enablePluginHooks gate was enforced by the
      // loader, which only emits plugin-tier groups when it is set.
      if (group.tier !== 'plugin' && !userGlobalEnabled) continue;

      // Per-hook disable: skip plugin groups that the user has listed in
      // `disabledPluginHooks`. The check is at group level (event+matcher)
      // so a single specifier can suppress an entire matcher group at once.
      // Non-plugin groups are never subject to this gate (it applies only to
      // plugin hooks; shell hooks have the enableShellHooks gate instead).
      if (group.tier === 'plugin') {
        const firstHook = group.hooks[0];
        const pName = firstHook?.pluginName;
        if (pName !== undefined &&
            isPluginHookDisabled(hookConfig.disabledPluginHooks, pName, event, group.matcher)) {
          console.warn(
            `[hooks] plugin hook suppressed by disabledPluginHooks: plugin="${pName}" ` +
              `event="${event}"` +
              (group.matcher !== undefined ? ` matcher="${group.matcher}"` : ''),
          );
          continue;
        }
      }

      // Compile the matcher once per group — not per dispatch.
      // Pass a warn sink so invalid regex patterns are surfaced via console.warn
      // instead of silently falling back without any signal to the operator.
      const matchFn = compileMatcher(group.matcher, (msg) => console.warn(`[hooks] ${msg}`));

      for (const hook of group.hooks) {
        const hookCommand = hook.command;
        const hookTimeoutMs = hook.timeoutMs;
        const hookPluginRoot = hook.pluginRoot;
        const hookPluginName = hook.pluginName;
        const hookPluginKey = hook.pluginKey;

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

          // Prefer the live event context.sessionId over the registration-time
          // agentConfig.sessionId so REPL / `afk chat` hooks receive the
          // provider-assigned id rather than undefined. Falls back to the
          // registration-time id for events whose context type carries no
          // sessionId (SubagentStart, SubagentStop).
          const effectiveSessionId = resolveContextSessionId(context, sessionId);

          // Resolve the live transcript path at dispatch time (not registration
          // time) so rotations from /clear are captured automatically.
          const transcriptPath = getTranscriptPath?.() ?? null;

          // Resolve plugin options and key from the index for user-scope
          // plugins so CLAUDE_PLUGIN_OPTION_* and CLAUDE_PLUGIN_DATA are
          // available in the hook subprocess.
          let resolvedPluginKey: string | undefined;
          let resolvedPluginOptions: Record<string, string> | undefined;
          if (hookPluginKey !== undefined) {
            // The index key is the install key, not the manifest name. Marketplace
            // installs use `<marketplace>:<plugin>` and aliased flat installs use
            // the directory/alias key, so manifest-name lookup can miss or leak a
            // same-named plugin's options and data directory.
            const idx = readIndex();
            const idxEntry = idx.plugins[hookPluginKey];
            if (idxEntry !== undefined) {
              resolvedPluginKey = hookPluginKey;
              resolvedPluginOptions = idxEntry.options;
            }
          }

          const result = await executeCommand({
            command: hookCommand,
            context,
            agentCwd,
            sessionId: effectiveSessionId,
            timeoutMs: hookTimeoutMs,
            transcriptPath,
            ...(hookPluginRoot !== undefined ? { pluginRoot: hookPluginRoot } : {}),
            ...(hookPluginName !== undefined ? { pluginName: hookPluginName } : {}),
            ...(hookPluginName !== undefined ? { pluginHookEnv: hookConfig.pluginHookEnv } : {}),
            ...(resolvedPluginKey !== undefined ? { pluginKey: resolvedPluginKey } : {}),
            ...(resolvedPluginOptions !== undefined ? { pluginOptions: resolvedPluginOptions } : {}),
          });

          return result.decision;
        };

        registry.register(event, handler);
      }
    }
  }
}
