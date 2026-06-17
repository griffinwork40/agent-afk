/**
 * Factory for a `HookRegistry` pre-populated with the built-in
 * hook handlers. Entry points should use this instead of the bare
 * `createHookRegistry()` unless they explicitly want no built-ins.
 *
 * @module agent/default-hook-registry
 */

import { createHookRegistry, type HookRegistry } from './hooks.js';
import { shadowVerifyNudge } from './shadow-verify-nudge.js';
import { MemoryStore, createMemorySessionEndHook } from './memory/index.js';
import { createPlanModeGate } from './plan-mode-gate.js';
import { createAfkModeGate } from './afk-mode-gate.js';
import { cleanupComposeSpills } from './tools/compose-executor.js';
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
}

export function createDefaultHookRegistry(
  onSubagentComplete?: (info: SubagentCompleteInfo) => void,
  surface?: string,
  memoryStore?: MemoryStore,
  getPermissionMode?: () => PermissionMode,
  hookConfig?: LoadedHooksConfig,
  agentOptions?: { cwd?: string; sessionId?: string },
): DefaultHookRegistryResult {
  const registry = createHookRegistry();
  registry.register('SubagentStop', shadowVerifyNudge);
  const store = memoryStore ?? new MemoryStore();
  if (getPermissionMode !== undefined) {
    registry.register('PreToolUse', createPlanModeGate(getPermissionMode));
    // AFK-mode safety ceiling. Reads the same mode getter; AFK ('autonomous')
    // and plan are mutually exclusive permission modes, so at most one of the
    // two gates ever fires for a given tool call. Unlike the plan gate, this
    // one applies tree-wide (no subagent exemption) — see afk-mode-gate.ts.
    registry.register(
      'PreToolUse',
      createAfkModeGate(getPermissionMode, agentOptions?.cwd),
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

  return { registry, memoryStore: store };
}
