import { createDefaultHookRegistry } from '../../../agent/default-hook-registry.js';
import { loadHooksConfig } from '../../../agent/hooks/config-loader.js';
import type { HookRegistry } from '../../../agent/hooks.js';
import type { MemoryStore } from '../../../agent/memory/index.js';
import type { TraceWriter } from '../../../agent/trace/index.js';
import type { SessionStats } from '../../slash/types.js';
import type { CompletionWriter } from './shared.js';
import { emitSubagentCompletion } from './progress-banner.js';
import { createTerminalStateGate } from './terminal-state-gate.js';
import { loadConfig } from '../../config.js';

/**
 * Build the stable hook registry shared across sessions (including
 * mid-session `/resume` swaps) and register the terminal-state Stop gate on
 * top of it.
 *
 * The hook callbacks close over `stats` and `completionWriter`, which are
 * also stable, so a rebuilt session gets the same routing without re-wiring.
 * `pathApprovalGrantRef` is populated by the caller once the provider
 * exists — the path-approval hook fails open until then (mirroring
 * `setAllowDirDispatcher` wiring order).
 *
 * The terminal-state gate (issue #237) is a post-turn `Stop` hook that
 * bounces a self-certified `Done` with no corroborating evidence back into
 * the next turn via the Stop injectContext primitive (wired in
 * loop-iteration.ts). Registered here rather than in
 * `createDefaultHookRegistry` because it reads cli-layer config
 * (`enforceDoneEvidence`, fresh each turn) and the live permission mode;
 * opt-in + autonomous-only, so it is inert unless the operator enabled it.
 * REPL surface only — the Stop injectContext delivery it depends on lives in
 * the REPL loop.
 */
export function createReplHookRegistry(a: {
  completionWriter: CompletionWriter;
  memoryStore: MemoryStore;
  stats: SessionStats;
  effectiveCwd: string | undefined;
  traceWriter: TraceWriter | undefined;
}): { hookRegistry: HookRegistry; pathApprovalGrantRef: { current: unknown } } {
  const hookRegistryBundle = createDefaultHookRegistry(
    (info) => { emitSubagentCompletion(a.completionWriter, info); },
    'cli',
    a.memoryStore,
    () => a.stats.permissionMode,
    loadHooksConfig({ cwd: a.effectiveCwd }),
    { cwd: a.effectiveCwd, ...(a.traceWriter !== undefined ? { traceWriter: a.traceWriter } : {}) },
    () => a.effectiveCwd ?? process.cwd(),
  );
  const hookRegistry = hookRegistryBundle.registry;
  const pathApprovalGrantRef = hookRegistryBundle.pathApprovalGrantRef;

  hookRegistry.register(
    'Stop',
    createTerminalStateGate({
      getPermissionMode: () => a.stats.permissionMode,
      isEnabled: () => loadConfig().enforceDoneEvidence === true,
    }),
  );

  return { hookRegistry, pathApprovalGrantRef };
}
