/**
 * Site-level guard for #5169: after close and after reset, no drain timer may
 * be left pending. These fail if either call site goes back to an inline
 * `Promise.race` against an uncleared `setTimeout`.
 *
 * @module agent/session/drain-timer-sites.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { drainAndFinalizeClose, type CloseDrainDeps } from './agent-session.close.js';
import { resetSession, type ResetDeps } from './session-reset.js';
import type { AgentConfig } from '../types.js';

const noop = async (): Promise<void> => {};
const doneIterator = {
  next: async () => ({ done: true, value: undefined }),
  return: async () => ({ done: true, value: undefined }),
};

function closeDeps(initPromise: Promise<void> | null): CloseDrainDeps {
  return {
    abortController: new AbortController(),
    stateManager: { resolveInitializationIfNeeded: () => undefined },
    providerQuery: { close: noop },
    providerIterator: doneIterator,
    initPromise,
    journal: { close: noop },
    shutdown: { dispatchOnce: noop },
    env: undefined,
  } as unknown as CloseDrainDeps;
}

function resetDeps(initPromise: Promise<void> | null): ResetDeps {
  return {
    getState: () => 'idle',
    setState: () => undefined,
    getAbortController: () => new AbortController(),
    getProviderQuery: () => ({ interrupt: noop, close: noop }),
    getProviderIterator: () => doneIterator,
    getInitPromise: () => initPromise,
    getShutdown: () => ({ dispatchOnce: noop }),
    getLedger: () => ({ seal: noop }),
    getJournal: () => ({
      closeForReset: noop,
      stripForReset: (c: AgentConfig) => ({ ...c }),
      markCleared: () => undefined,
    }),
    getStateManager: () => ({ resolveInitializationIfNeeded: () => undefined }),
    reinitialize: (patch: (prev: AgentConfig) => AgentConfig) => { patch({ model: 'm' }); },
  } as unknown as ResetDeps;
}

describe('drain timer is cleared at both call sites (#5169)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('close leaves no pending timer when init has already settled', async () => {
    await drainAndFinalizeClose(closeDeps(Promise.resolve()));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close leaves no pending timer when init rejected', async () => {
    const rejected = Promise.reject(new Error('init failed'));
    await drainAndFinalizeClose(closeDeps(rejected));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reset leaves no pending timer when init has already settled', async () => {
    await resetSession(resetDeps(Promise.resolve()));
    expect(vi.getTimerCount()).toBe(0);
  });
});
