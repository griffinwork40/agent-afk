import { describe, expect, it } from 'vitest';

import { resetSession, type ResetDeps } from './session-reset.js';
import type { AgentConfig, SessionState } from '../types.js';

/** Fake deps that record the order of teardown steps. */
function makeDeps(state: SessionState = 'processing'): { deps: ResetDeps; order: string[] } {
  const order: string[] = [];
  const step = (name: string) => async (): Promise<void> => { order.push(name); };
  const deps = {
    getState: () => state,
    setState: () => undefined,
    getAbortController: () => new AbortController(),
    getProviderQuery: () => ({ interrupt: step('interrupt'), close: step('provider.close') }),
    getProviderIterator: () => ({ next: async () => ({ done: true, value: undefined }), return: async () => { order.push('iterator.return'); return { done: true, value: undefined }; } }),
    getInitPromise: () => null,
    getShutdown: () => ({ dispatchOnce: step('shutdown') }),
    getLedger: () => ({ seal: step('ledger.seal') }),
    getJournal: () => ({
      closeForReset: step('journal.closeForReset'),
      stripForReset: (c: AgentConfig) => { order.push('journal.strip'); return { ...c }; },
      markCleared: () => { order.push('journal.markCleared'); },
    }),
    getStateManager: () => ({ resolveInitializationIfNeeded: () => { order.push('state.resolveInit'); } }),
    reinitialize: (patch: (prev: AgentConfig) => AgentConfig) => { order.push('reinitialize'); patch({ model: 'm' }); },
  } as unknown as ResetDeps;
  return { deps, order };
}

describe('resetSession ordering', () => {
  it('closes the journal after the provider close + iterator drain and before the rebuild', async () => {
    const { deps, order } = makeDeps();
    await resetSession(deps);
    const at = (s: string): number => order.indexOf(s);
    expect(at('journal.closeForReset')).toBeGreaterThan(at('provider.close'));
    expect(at('journal.closeForReset')).toBeGreaterThan(at('iterator.return'));
    expect(at('journal.closeForReset')).toBeLessThan(at('reinitialize'));
    expect(order.at(-1)).toBe('journal.markCleared');
  });
});
