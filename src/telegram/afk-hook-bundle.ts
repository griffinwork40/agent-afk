/**
 * Telegram hook bundle.
 *
 * Builds the shared hook registry for the always-on Telegram host. Extracted
 * from `telegram.ts main()` so the wiring is unit-testable and cannot silently
 * regress. Contract pinned by afk-hook-bundle.test.ts.
 */

import {
  createDefaultHookRegistry,
  type DefaultHookRegistryResult,
} from '../agent/default-hook-registry.js';
import { loadHooksConfig } from '../agent/hooks/config-loader.js';
import { resolveModelId } from '../agent/session/model-resolution.js';
import type { MemoryStore } from '../agent/memory/index.js';
import type { AgentSession } from '../agent/session.js';
import type { TraceWriter } from '../agent/trace/index.js';
import { createTerminalStateGate } from '../agent/terminal-state-gate.js';
import { loadConfig } from '../cli/config.js';

export interface TelegramAfkHookBundleParams {
  /** Shared cross-session memory store (3rd positional arg of the registry). */
  memoryStore: MemoryStore | undefined;
  /**
   * Late-bound accessor for THIS chat's session. The registry's mode getter is
   * built before the session exists (the session's hookRegistry IS this bundle),
   * so the accessor closes over a `let` the caller assigns post-construction —
   * `() => session` reads the live value once bound.
   */
  getSession: () => AgentSession | undefined;
  /** Session cwd (AFK_TELEGRAM_CWD / sessionConfig.cwd), or undefined. */
  cwd: string | undefined;
  /** Telegram trace writer, or null when tracing is disabled. */
  traceWriter: TraceWriter | null;
}

/**
 * Build the Telegram hook registry. Byte-equivalent to the two former inline
 * `createDefaultHookRegistry(...)` calls in `telegram.ts main()`; both
 * branches now call this.
 */
export function createTelegramAfkHookBundle(
  params: TelegramAfkHookBundleParams,
): DefaultHookRegistryResult {
  const { memoryStore, getSession, cwd, traceWriter } = params;
  const getPermissionMode = () => getSession()?.getSessionMetadata().permissionMode ?? 'bypassPermissions';
  const result = createDefaultHookRegistry(
    undefined,
    'telegram',
    memoryStore,
    // Live getter: registers the plan-mode gate; falls back to the fully-
    // contained 'default' until the session is late-bound.
    getPermissionMode,
    loadHooksConfig(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
    {
      cwd: cwd !== undefined && cwd.length > 0 ? cwd : undefined,
      ...(traceWriter !== null ? { traceWriter } : {}),
      getModel: () => {
        const s = getSession();
        const m = s?.getSessionMetadata().model;
        return m !== undefined ? (resolveModelId(m) ?? String(m)) : undefined;
      },
    },
    () => cwd,
  );

  // Register the terminal-state gate on the Telegram surface. Fires only when
  // `enforceDoneEvidence` is true in afk.config.json.
  result.registry.register(
    'Stop',
    createTerminalStateGate({
      isEnabled: () => loadConfig().enforceDoneEvidence === true,
    }),
  );

  return result;
}
