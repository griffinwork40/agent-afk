/**
 * Drain-and-finalize tail of `AgentSession.close()`.
 *
 * Extracted from agent-session.ts so that file stays under the 350-code-line
 * ceiling (#2933 added a try/finally around the finalize step). Takes every
 * dependency as an explicit parameter; it closes over no session state.
 *
 * @module agent/session/agent-session.close
 */

import type { ProviderEvent, ProviderQuery } from '../provider.js';
import type { AgentConfig } from '../types.js';
import { RESET_DRAIN_TIMEOUT_MS } from '../timeout.js';
import type { JournalLifecycle } from './journal-lifecycle.js';
import type { SessionShutdown } from './session-shutdown.js';
import type { SessionStateManager } from './session-state.js';
import { cleanupSessionTmpdir } from './session-tmpdir.js';

export interface CloseDrainDeps {
  readonly abortController: AbortController;
  readonly stateManager: SessionStateManager;
  readonly providerQuery: ProviderQuery;
  readonly providerIterator: AsyncIterator<ProviderEvent>;
  readonly initPromise: Promise<void> | null;
  readonly journal: JournalLifecycle;
  readonly shutdown: SessionShutdown;
  readonly env: AgentConfig['env'];
}

/**
 * Abort + drain the provider, then close the journal, dispatch shutdown, and
 * release the session TMPDIR.
 */
export async function drainAndFinalizeClose(deps: CloseDrainDeps): Promise<void> {
  // Invariant: abort and drain the provider BEFORE closing the journal.
  // Both providers perform final journal synchronization during their
  // abort/turn-finalization paths (JournalSync.sync at commit points).
  // Closing the journal first silently discards those writes, leaving the
  // journal ending at an unmatched tool_use or missing completed tool
  // results — corrupting the resume source. The reset path (session-reset.ts)
  // already follows this order: provider.close() + iterator.return + drain
  // initPromise → closeForReset(). close() must match it.
  if (!deps.abortController.signal.aborted) deps.abortController.abort('closed');
  deps.stateManager.resolveInitializationIfNeeded();
  try {
    await deps.providerQuery.close();
  } catch {
    // ignore
  }
  await deps.providerIterator.return?.();
  if (deps.initPromise) {
    try {
      await Promise.race([deps.initPromise, new Promise((resolve) => setTimeout(resolve, RESET_DRAIN_TIMEOUT_MS))]);
    } catch {
      // ignore
    }
  }
  try {
    await deps.journal.close();
    await deps.shutdown.dispatchOnce('close');
  } finally {
    // Registry cleanup runs in a finally so a journal-close or shutdown-dispatch
    // error does not leak the registry entry (#2933 registry-leak).
    // After drain: children are done with their dirs.
    await cleanupSessionTmpdir(deps.env);
  }
}
