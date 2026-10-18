/**
 * Per-cycle lifecycle helpers for `AgentSession.initSdkLifecycle()`.
 *
 * Extracted so `agent-session.ts` stays within the 350-code-line ceiling.
 * These functions are tightly coupled to `AgentSession` internals and are
 * not part of the public API.
 *
 * @module agent/session/agent-session.lifecycle
 */

import { TurnStreamRunner, type TurnRunnerDeps } from './turn-stream-runner.js';
import { buildProviderLifecycle, rebuildProviderQuery } from './provider-lifecycle.js';
import { ProviderInitializer } from './provider-lifecycle.js';
import { ensureError } from '../../utils/errors.js';
import type { AgentConfig } from '../types.js';
import type { AccountingAccumulator } from './accounting-accumulator.js';
import type { SessionShutdown } from './session-shutdown.js';
import type { SessionStateManager } from './session-state.js';
import type { HookRegistry } from '../hooks.js';
import type { ProviderQuery, ProviderEvent } from '../provider.js';
import type { QueryInputStream } from './input-iterable.js';

/** Mutable slots on AgentSession that `buildSessionRunner` reads and writes. */
export interface SessionRunnerSlots {
  getConfig: () => AgentConfig;
  getAbortController: () => AbortController;
  getProviderIterator: () => AsyncIterator<ProviderEvent>;
  stateManager: SessionStateManager;
  accounting: AccountingAccumulator;
  ledger: import('./ledger-lifecycle.js').LedgerLifecycle;
  outputBroadcast: import('./output-broadcast.js').OutputBroadcast;
  conversationHistory: import('../types.js').Message[];
  getInitPromise: () => Promise<void> | null;
  getSessionId: () => string | undefined;
  getState: () => import('../types.js').SessionState;
  setState: (s: import('../types.js').SessionState) => void;
  getLastResponseMetadata: () => import('../types.js').ResponseMetadata | null;
  setLastResponseMetadata: (m: import('../types.js').ResponseMetadata | null) => void;
  getPendingFrameworkContext: () => string[];
  setPendingFrameworkContext: (v: string[]) => void;
  getInboundMessageCount: () => number;
  incInboundMessageCount: () => number;
  getTurnCount: () => number;
  incTurnCount: () => void;
  getProviderQuery: () => ProviderQuery;
  getStopWiring: () => import('../types/session-types.js').StopWiring | undefined;
  observeProviderEvent: (e: ProviderEvent) => void;
}

/**
 * Construct the `TurnStreamRunner` from `AgentSession`'s per-cycle slots.
 * Extracted verbatim from `initSdkLifecycle` to keep that method under the
 * file-size ceiling.
 */
export function buildSessionRunner(slots: SessionRunnerSlots): TurnStreamRunner {
  return new TurnStreamRunner({
    getConfig: slots.getConfig,
    getAbortController: slots.getAbortController,
    getProviderIterator: slots.getProviderIterator,
    stateManager: slots.stateManager,
    accounting: slots.accounting,
    ledger: slots.ledger,
    outputBroadcast: slots.outputBroadcast,
    conversationHistory: slots.conversationHistory,
    getInitPromise: slots.getInitPromise,
    getSessionId: slots.getSessionId,
    getState: slots.getState,
    setState: slots.setState,
    getLastResponseMetadata: slots.getLastResponseMetadata,
    setLastResponseMetadata: slots.setLastResponseMetadata,
    getPendingFrameworkContext: slots.getPendingFrameworkContext,
    setPendingFrameworkContext: slots.setPendingFrameworkContext,
    getInboundMessageCount: slots.getInboundMessageCount,
    incInboundMessageCount: slots.incInboundMessageCount,
    getTurnCount: slots.getTurnCount,
    incTurnCount: slots.incTurnCount,
    getProviderQuery: slots.getProviderQuery,
    getLedgerMetadata: () => slots.stateManager.getSessionMetadata(),
    observeProviderEvent: slots.observeProviderEvent,
    getStopWiring: slots.getStopWiring,
  } satisfies TurnRunnerDeps);
}

/** Slots written by `applyLifecycle` after `buildProviderLifecycle` returns. */
export interface LifecycleWriteSlots {
  setStateManager: (v: SessionStateManager) => void;
  setInputStream: (v: import('./input-iterable.js').QueryInputStream) => void;
  setProviderQuery: (v: ProviderQuery) => void;
  setProviderIterator: (v: AsyncIterator<ProviderEvent>) => void;
}

/**
 * Apply the result of `buildProviderLifecycle` to the session's live fields.
 * Extracted from `initSdkLifecycle` to keep `agent-session.ts` under ceiling.
 */
export function applyLifecycle(
  config: AgentConfig,
  slots: LifecycleWriteSlots,
): SessionStateManager {
  const lc = buildProviderLifecycle(config);
  slots.setStateManager(lc.stateManager);
  slots.setInputStream(lc.inputStream);
  slots.setProviderQuery(lc.providerQuery);
  slots.setProviderIterator(lc.providerIterator);
  return lc.stateManager;
}

export interface BuildInitPromiseOptions {
  mcpInitPromise: Promise<void>;
  getConfig: () => AgentConfig;
  setProviderQuery: (q: ProviderQuery) => void;
  setProviderIterator: (i: AsyncIterator<ProviderEvent>) => void;
  getProviderIterator: () => AsyncIterator<ProviderEvent>;
  /** Returns the Phase-1 `QueryInputStream` so Phase 2 can reuse its iterable. */
  getInputStream: () => QueryInputStream;
  /** Returns true when the session has been closed (to abort Phase 2). */
  isClosed: () => boolean;
  abortSignal: AbortSignal;
  accounting: AccountingAccumulator;
  shutdown: SessionShutdown;
  hookRegistry: HookRegistry | undefined;
  queueFrameworkContext: (text: string) => void;
  getRunner: () => TurnStreamRunner;
  stateManager: SessionStateManager;
}

/**
 * Build the two-phase `initPromise` for `initSdkLifecycle`.
 *
 * Phase 2 runs after `mcpInitPromise` settles:
 *   - If the session was closed while MCP init was in flight, disconnect is
 *     handled by the `startMcpInit` callback; Phase 2 is skipped entirely so
 *     a rebuilt provider is never started after close.
 *   - If `config.mcpManager` is now set, the provider query/iterator are
 *     rebuilt using the EXISTING Phase-1 `inputStream`'s iterable, so
 *     `AgentSession.inputStream` (used by `sendMessage`) feeds the active
 *     provider. Creating a fresh `QueryInputStream` here would discard the
 *     Phase-1 stream and stall every subsequent `sendMessage`.
 *   - If `mcpInitPromise` rejects (e.g. an `alwaysLoad` server fails or a
 *     tool-name conflict is detected), `waitForInitialization()` is rejected
 *     and shutdown is dispatched — mirroring `ProviderInitializer.run`'s catch.
 */
export function buildSessionInitPromise(opts: BuildInitPromiseOptions): Promise<void> {
  // Invariant: this snapshot is the manager Phase 1 built its provider with.
  // `initSdkLifecycle` calls this synchronously right after Phase 1, and the
  // `startMcpInit` patch lands in a later microtask, so the patched manager is
  // never visible here. A caller-supplied `mcpManager` (daemon, CLI, Telegram)
  // is already in the Phase-1 provider, so Phase 2 must not rebuild for it:
  // doing so ran `provider.query()` twice per session (land round 3, #4069).
  const phase1Manager = opts.getConfig().mcpManager;
  return opts.mcpInitPromise.then(
    () => {
      // Item 3: skip Phase-2 provider rebuild if session was closed while MCP
      // init was in flight. The owned manager is disconnected by the
      // `startMcpInit` callback on the calling side.
      if (opts.isClosed()) return;

      const phase2Manager = opts.getConfig().mcpManager;
      if (phase2Manager !== undefined && phase2Manager !== phase1Manager) {
        // Item 1: reuse the Phase-1 inputStream's iterable so sendMessage
        // pushes into the stream the rebuilt provider actually reads.
        const promptIterable = opts.getInputStream().createIterable();
        const rebuilt = rebuildProviderQuery(opts.getConfig(), promptIterable);
        opts.setProviderQuery(rebuilt.providerQuery);
        opts.setProviderIterator(rebuilt.providerIterator);
      }

      // #4064: read the manager here, after MCP init has settled, so an
      // SDK-built manager (#4063) gets the failure notice as well as a
      // caller-supplied one.
      const mcpManager = opts.getConfig().mcpManager;
      const initializer = new ProviderInitializer(
        opts.getConfig(),
        opts.abortSignal,
        opts.accounting,
        opts.shutdown,
        opts.hookRegistry,
        opts.queueFrameworkContext,
        mcpManager !== undefined ? () => mcpManager.getServerStates() : undefined,
      );
      return initializer.run(
        opts.getProviderIterator,
        () => opts.getRunner().buildTransformDeps(),
        opts.stateManager,
      );
    },
    // Item 2: MCP init rejected — settle waitForInitialization() and dispatch
    // shutdown, mirroring ProviderInitializer.run's catch block exactly.
    async (err: unknown) => {
      const error = ensureError(err);
      if (!opts.stateManager.isInitializationSettled()) {
        opts.stateManager.rejectInitializationOnce(error);
      }
      await opts.shutdown.dispatchOnce('error').catch(() => {});
    },
  );
}
