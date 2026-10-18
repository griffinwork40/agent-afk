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
import { buildProviderLifecycle } from './provider-lifecycle.js';
import { ProviderInitializer } from './provider-lifecycle.js';
import type { AgentConfig } from '../types.js';
import type { AccountingAccumulator } from './accounting-accumulator.js';
import type { SessionShutdown } from './session-shutdown.js';
import type { SessionStateManager } from './session-state.js';
import type { HookRegistry } from '../hooks.js';
import type { ProviderQuery, ProviderEvent } from '../provider.js';

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
 * Phase 2 runs after `mcpInitPromise` settles: if `config.mcpManager` is now
 * set, it rebuilds the provider query/iterator so the provider sees the
 * manager. Then it runs `ProviderInitializer` to pull `session.init`.
 */
export function buildSessionInitPromise(opts: BuildInitPromiseOptions): Promise<void> {
  return opts.mcpInitPromise.then(() => {
    if (opts.getConfig().mcpManager !== undefined) {
      const updated = buildProviderLifecycle(opts.getConfig());
      opts.setProviderQuery(updated.providerQuery);
      opts.setProviderIterator(updated.providerIterator);
    }

    const initializer = new ProviderInitializer(
      opts.getConfig(),
      opts.abortSignal,
      opts.accounting,
      opts.shutdown,
      opts.hookRegistry,
      opts.queueFrameworkContext,
    );
    return initializer.run(
      opts.getProviderIterator,
      () => opts.getRunner().buildTransformDeps(),
      opts.stateManager,
    );
  });
}
