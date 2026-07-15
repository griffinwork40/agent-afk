/**
 * AFK autonomous-safety hook wiring for the always-on Telegram host.
 *
 * `telegram.ts main()` builds two structurally identical hook registries (the
 * Anthropic-direct branch and the OpenAI-compatible "codex" branch). Both encode
 * two load-bearing safety invariants; this factory is the single home for them:
 *
 *   1. A LIVE per-session permission-mode getter. Passing a real getter (never
 *      `undefined`) is what REGISTERS the afk-mode safety gate on Telegram —
 *      `createDefaultHookRegistry` only wires the gate when `getPermissionMode`
 *      is defined, so the prior `undefined` meant an autonomous Telegram session
 *      had NO risk ceiling. Reading the session's LIVE mode lets the gate track a
 *      runtime `/afk on` flip (handlers/afk.ts). The `?? 'default'` fallback is
 *      fail-safe: before the session is late-bound the mode reads as the fully
 *      path-contained 'default', never 'autonomous'.
 *   2. `afkPromptForApproval: false`. On the persistent, always-on phone host a
 *      high-risk / irreversible op HARD-REFUSES (+ Asking summary) rather than
 *      being one-tap-approvable from a standing surface with a possibly-broad
 *      cwd. See docs/afk-telegram-native-host.md.
 *
 * Extracted from `main()` — which is module-self-invoked (`telegram.ts` ends with
 * `main().catch(...)`) and therefore unreachable from any test — precisely so
 * these two safety args are UNIT-TESTABLE and cannot silently regress to
 * phone-approvable / gate-unregistered. Contract pinned by afk-hook-bundle.test.ts.
 */

import {
  createDefaultHookRegistry,
  type DefaultHookRegistryResult,
} from '../agent/default-hook-registry.js';
import { loadHooksConfig } from '../agent/hooks/config-loader.js';
import type { MemoryStore } from '../agent/memory/index.js';
import type { AgentSession } from '../agent/session.js';
import type { TraceWriter } from '../agent/trace/index.js';

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
 * Build the Telegram hook registry with the AFK autonomous-safety wiring. Byte-
 * equivalent to the two former inline `createDefaultHookRegistry(...)` calls in
 * `telegram.ts main()`; both branches now call this.
 */
export function createTelegramAfkHookBundle(
  params: TelegramAfkHookBundleParams,
): DefaultHookRegistryResult {
  const { memoryStore, getSession, cwd, traceWriter } = params;
  return createDefaultHookRegistry(
    undefined,
    'telegram',
    memoryStore,
    // Live getter: registers the afk-mode gate AND tracks `/afk on`; falls back
    // to the fully-contained 'default' until the session is late-bound.
    () => getSession()?.getSessionMetadata().permissionMode ?? 'default',
    loadHooksConfig(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
    {
      cwd: cwd !== undefined && cwd.length > 0 ? cwd : undefined,
      ...(traceWriter !== null ? { traceWriter } : {}),
      // Always-on host posture: hard-refuse high-risk ops, never phone-approve.
      afkPromptForApproval: false,
    },
    () => cwd,
  );
}
