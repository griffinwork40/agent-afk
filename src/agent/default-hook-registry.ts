/**
 * Factory for a `HookRegistry` pre-populated with AFK's built-in
 * hook handlers. Entry points should use this instead of the bare
 * `createHookRegistry()` unless they explicitly want no built-ins.
 *
 * @module agent/default-hook-registry
 */

import { createHookRegistry, type HookRegistry } from './hooks.js';
import { shadowVerifyNudge } from './shadow-verify-nudge.js';
import { MemoryStore, createMemorySessionEndHook } from './memory/index.js';
import { createPlanModeGate } from './plan-mode-gate.js';
import { cleanupComposeSpills } from './tools/compose-executor.js';
import { env } from '../config/env.js';
import {
  createPathApprovalHook,
  type PathApprovalSurface,
} from './tools/hooks/path-approval-hook.js';
import { createBashRestrictionHook } from './tools/hooks/bash-restriction-hook.js';
import type { GrantManager } from '../cli/slash/commands/allow-dir.js';
import type { PermissionMode } from './types/sdk-types.js';
import type { LoadedHooksConfig } from './hooks/config-loader.js';
import { loadAndRegisterConfigHooks } from './hooks/config-bridge.js';

export interface SubagentCompleteInfo {
  subagentId: string;
  status: string;
  durationMs?: number;
  agentType?: string;
}

export interface DefaultHookRegistryResult {
  registry: HookRegistry;
  memoryStore: MemoryStore;
  /**
   * Mutable ref the surface bootstrap MUST populate with the active provider
   * (which implements {@link GrantManager}) after session construction. Path-
   * approval + bash-restriction hooks dereference this on every PreToolUse;
   * leaving it null makes the path-approval hook fail OPEN — it skips the
   * elicitation prompt (the typed-file-tool handler's own resolveAndContain
   * still enforces containment), and the bash hook's restricted-root substring
   * check also fails open. (The bash interpreter denylist still hard-blocks
   * regardless — it runs before the grant-manager gate. See the registration
   * block below for the full per-surface breakdown.)
   *
   * Wiring pattern (see `src/cli/commands/interactive/bootstrap.ts:532`):
   *   pathApprovalGrantRef.current = provider;
   *
   * The same ref drives `setAllowDirDispatcher(provider)` callers — both
   * read the live provider grant API.
   */
  pathApprovalGrantRef: { current: GrantManager | undefined };
}

export function createDefaultHookRegistry(
  onSubagentComplete?: (info: SubagentCompleteInfo) => void,
  surface?: string,
  memoryStore?: MemoryStore,
  getPermissionMode?: () => PermissionMode,
  hookConfig?: LoadedHooksConfig,
  agentOptions?: { cwd?: string; sessionId?: string },
  getCwd?: () => string | undefined,
): DefaultHookRegistryResult {
  const registry = createHookRegistry();
  registry.register('SubagentStop', shadowVerifyNudge);
  const store = memoryStore ?? new MemoryStore();
  if (getPermissionMode !== undefined) {
    registry.register('PreToolUse', createPlanModeGate(getPermissionMode));
  }

  // Path-approval + bash-restriction hooks. Both share a mutable grant-manager
  // ref that the surface bootstrap populates after the provider exists.
  // `AFK_DISABLE_PATH_APPROVAL=1` skips registration entirely — escape hatch
  // for headless flows where wide-open access is desired (CI scripts, etc.).
  //
  // Invariant: registration order matters. Path-approval (typed file tools)
  // runs BEFORE bash-restriction so the model gets the interactive prompt
  // path first when both could apply (e.g. an edit_file followed by a bash
  // grep against the same restricted root within one turn).
  //
  // Invariant: only the REPL and Telegram bootstraps wire
  // `pathApprovalGrantRef.current` (see bootstrap.ts / telegram bot.start) — and
  // today ONLY when the active provider is AnthropicDirectProvider. OpenAI-
  // compatible providers implement GrantManager but are not yet wired, so an
  // OpenAI/Codex REPL or Telegram session also runs path-approval fail-open
  // (tracked in #166). Headless surfaces (afk chat, daemon, threads) register
  // these hooks but never wire the ref, so on those surfaces:
  //   - path-approval PreToolUse: fails open (no prompt; the typed-tool
  //     handler's own resolveAndContain still enforces containment);
  //   - bash restricted-root substring check: fails open (no backstop);
  //   - bash interpreter denylist: STILL hard-blocks (it runs before the
  //     grant-manager gate). Lift just this guard with
  //     AFK_DISABLE_BASH_INTERPRETER_GUARD=1, or disable the whole feature
  //     with AFK_DISABLE_PATH_APPROVAL=1.
  const pathApprovalGrantRef: { current: GrantManager | undefined } = {
    current: undefined,
  };
  const disabled = env.AFK_DISABLE_PATH_APPROVAL === '1';
  if (!disabled) {
    const pathApproval = createPathApprovalHook({
      getGrantManager: () => pathApprovalGrantRef.current,
      // Prefer an explicit getCwd callback (REPL/Telegram bootstrap thread a
      // live `extras.cwd`); otherwise fall back to the static cwd carried in
      // main's `agentOptions` (scheduler/chat/threads callers). Both feed the
      // path-approval containment check's resolveBase.
      getCwd: getCwd ?? (() => agentOptions?.cwd),
      surface: mapSurface(surface),
    });
    registry.register(
      'PreToolUse',
      pathApproval.preToolUse,
      // Longrunning: the hook awaits elicitationRouter.route(), which has no
      // time-based deadline (it waits as long as the operator needs). Bypass
      // the 30s per-handler deadline; the hook forwards the turn signal so
      // session/turn teardown still cancels the pending prompt.
      { longRunning: true },
    );
    // PostToolUse revokes "Once" grants after the call completes. Synchronous
    // (no I/O, just Map/Set/Array mutations) — default timeout suffices.
    registry.register('PostToolUse', pathApproval.postToolUse);
    // SessionEnd safety net: revoke any "Once" grants whose PostToolUse never
    // ran (e.g. the call's signal aborted before the revoke fired).
    registry.register('SessionEnd', pathApproval.sessionEnd);
    registry.register(
      'PreToolUse',
      createBashRestrictionHook({
        getGrantManager: () => pathApprovalGrantRef.current,
        // Granular escape: lift only the interpreter-eval denylist (which
        // fires on every surface, incl. headless) without disabling the rest
        // of path-approval. AFK_DISABLE_PATH_APPROVAL=1 already short-circuits
        // the whole `if (!disabled)` block above, so this is the finer knob.
        disableInterpreterGuard: env.AFK_DISABLE_BASH_INTERPRETER_GUARD === '1',
      }),
    );
  }

  registry.register('SessionEnd', createMemorySessionEndHook(store, surface));
  // Clean up compose-truncation spill files when the session ends. Files
  // are written under <sessions>/<sessionId>/compose/<callId>/<nodeId>.txt
  // by ComposeExecutor when a node's output exceeds MAX_NODE_OUTPUT_CHARS;
  // the parent uses them within the session to recover full output via
  // read_file. Once the session ends, the recovery window is closed.
  registry.register('SessionEnd', (context) => {
    if (context.event !== 'SessionEnd') return {};
    if (context.sessionId) cleanupComposeSpills(context.sessionId);
    return {};
  });
  if (onSubagentComplete) {
    registry.register('SubagentStop', (context) => {
      if (context.event !== 'SubagentStop') return {};
      if (context.status === 'idle' || context.status === 'running') return {};
      onSubagentComplete({
        subagentId: context.subagentId,
        status: context.status,
        durationMs: context.durationMs,
        agentType: context.agentType,
      });
      return {};
    });
  }

  // Register config-driven shell hooks after all built-ins so built-in
  // handlers always run first. Config hooks are optional — when no
  // hookConfig is provided (the common case) this is a no-op.
  if (hookConfig !== undefined) {
    loadAndRegisterConfigHooks(registry, hookConfig, {
      cwd: agentOptions?.cwd,
      sessionId: agentOptions?.sessionId,
    });
  }

  return { registry, memoryStore: store, pathApprovalGrantRef };
}

/**
 * Map the loose surface label threaded through {@link createDefaultHookRegistry}
 * to the {@link PathApprovalSurface} discriminator stamped into persisted
 * grants. Unknown labels fall through to `'unknown'`.
 */
function mapSurface(surface: string | undefined): PathApprovalSurface {
  if (surface === 'telegram') return 'telegram';
  if (surface === 'cli' || surface === 'repl') return 'repl';
  return 'unknown';
}
