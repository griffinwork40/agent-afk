/**
 * Session-reset logic, extracted from {@link AgentSession}.
 *
 * `resetSession()` tears down the current SDK lifecycle and rebuilds it
 * from the same `AgentConfig`, yielding a fresh conversation context.
 * This is what `/clear` invokes in the CLI — forwarding the literal string
 * does NOT clear context (the model sees plain user text).
 *
 * No back-reference to {@link AgentSession}: all external state is accessed
 * through the {@link ResetDeps} context bag and the `initSdkLifecycle`
 * callback.
 *
 * @module agent/session/session-reset
 */

import { AbortError } from '../../utils/errors.js';
import { RESET_DRAIN_TIMEOUT_MS } from '../timeout.js';
import type { AgentConfig, SessionState } from '../types.js';
import type { ProviderQuery, ProviderEvent } from '../provider.js';
import type { SessionStateManager } from './session-state.js';
import type { SessionShutdown } from './session-shutdown.js';
import type { LedgerLifecycle } from './ledger-lifecycle.js';

/** Context bag threaded into {@link resetSession}. */
export interface ResetDeps {
  getState: () => SessionState;
  setState: (s: SessionState) => void;
  getAbortController: () => AbortController;
  getProviderQuery: () => ProviderQuery;
  getProviderIterator: () => AsyncIterator<ProviderEvent>;
  getInitPromise: () => Promise<void> | null;
  getShutdown: () => SessionShutdown;
  getLedger: () => LedgerLifecycle;
  getStateManager: () => SessionStateManager;
  /** Strips resume-context fields and triggers the SDK lifecycle rebuild. */
  reinitialize: (patchConfig: (prev: AgentConfig) => AgentConfig) => void;
}

/**
 * Tear down the current SDK lifecycle and rebuild from the same config,
 * yielding a session whose conversation context is empty. Forwarding the
 * literal string `/clear` to a provider does NOT clear context (the model
 * sees plain user text), so `/clear` in the CLI calls this instead.
 *
 * Preserved across reset: `config`, the internal `abortController`,
 * `hookRegistry`. Reset: `providerQuery`, `providerIterator`,
 * `conversationHistory`, `turnCount`, `lastResponseMetadata`,
 * `inputStream`, `stateManager`.
 * Resume-context fields on `this.config` are stripped (see invariant below).
 */
export async function resetSession(deps: ResetDeps): Promise<void> {
  if (deps.getState() === 'closed') {
    throw new Error('Cannot reset: session is closed');
  }
  if (deps.getAbortController().signal.aborted) {
    throw new AbortError('Cannot reset: session aborted');
  }

  const state = deps.getState();
  if (state === 'processing' || state === 'streaming') {
    try {
      await deps.getProviderQuery().interrupt();
    } catch {
      // Provider interrupt may fail if already terminating; fall through.
    }
  }

  await deps.getShutdown().dispatchOnce('reset');
  await deps.getLedger().seal('reset');

  try {
    await deps.getProviderQuery().close();
  } catch {
    // ignore
  }
  await deps.getProviderIterator().return?.();
  const initPromise = deps.getInitPromise();
  if (initPromise) {
    await Promise.race([
      initPromise,
      new Promise((resolve) => setTimeout(resolve, RESET_DRAIN_TIMEOUT_MS)),
    ]).catch(() => {});
  }
  deps.getStateManager().resolveInitializationIfNeeded();

  // Invariant: /clear must yield a fresh conversation, not silently
  // re-attach to a previously-resumed session. Strip resume-context fields
  // so initSdkLifecycle() below starts a new conversation. See the full
  // rationale in the pre-extraction version of reset().
  try {
    deps.reinitialize((prev) => {
      const next = { ...prev };
      delete next.resume;
      delete next.sessionId;
      delete next.resumeHistory;
      delete next.resumeSessionAt;
      delete next.continue;
      delete next.forkSession;
      return next;
    });
  } catch (err) {
    deps.setState('closed');
    throw new Error(
      `Session reset failed during lifecycle rebuild: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
