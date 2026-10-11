/** Regression #3561: owned stores must reopen when a closed provider is reused. */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../memory/memory-store.js';
import { StateStore } from '../state/state-store.js';
import type { SessionToolDispatcher } from '../tools/dispatcher.js';
import { AnthropicDirectProvider } from './anthropic-direct/provider-runtime.js';
import { OpenAICompatibleProvider } from './openai-compatible/index.js';
import { makeDefaultMemoryStore, makeDefaultStateStore } from './shared/provider-stores.js';

vi.mock('./shared/provider-stores.js', () => ({
  makeDefaultMemoryStore: vi.fn(),
  makeDefaultStateStore: vi.fn(),
}));

describe('provider.close() owned store reuse', () => {
  let dir: string;
  let memoryStores: MemoryStore[];
  let stateStores: StateStore[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'afk-close-reuse-'));
    memoryStores = [];
    stateStores = [];
    vi.mocked(makeDefaultMemoryStore).mockImplementation(() => {
      const store = new MemoryStore(path.join(dir, 'memory'));
      memoryStores.push(store);
      return store;
    });
    vi.mocked(makeDefaultStateStore).mockImplementation(() => {
      const store = new StateStore(path.join(dir, 'kv.db'));
      stateStores.push(store);
      return store;
    });
  });

  afterEach(() => {
    for (const store of memoryStores) store.close();
    for (const store of stateStores) store.close();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const makers = [
    ['anthropic-direct', () => new AnthropicDirectProvider({ surface: 'daemon' })],
    ['openai-compatible', () => new OpenAICompatibleProvider({ surface: 'daemon' })],
  ] as const;

  for (const [name, make] of makers) {
    it(`${name}: close releases lazy stores and re-query builds working tools`, async () => {
      const provider = make();
      // Observe the real per-query dispatcher without starting a model/network turn.
      const build = vi.spyOn(provider as unknown as {
        buildDispatcher: (...args: unknown[]) => SessionToolDispatcher;
      }, 'buildDispatcher');
      const query = () => provider.query({
        prompt: (async function* () {})(),
        config: {
          model: name === 'anthropic-direct' ? 'claude-sonnet-4-6' : 'gpt-4o-mini',
          apiKey: 'test-key',
          cwd: dir,
          sessionId: 'close-reuse',
          permissionMode: 'bypassPermissions',
        },
      });
      const execute = (dispatcher: SessionToolDispatcher, tool: string, input: unknown) =>
        dispatcher.execute({ id: tool, name: tool, input, signal: new AbortController().signal });

      provider.close();
      expect(makeDefaultMemoryStore).not.toHaveBeenCalled();
      expect(makeDefaultStateStore).not.toHaveBeenCalled();
      const firstQuery = query();
      const firstDispatcher = build.mock.results[0]!.value as SessionToolDispatcher;
      expect(makeDefaultMemoryStore).toHaveBeenCalledTimes(1);
      expect(makeDefaultStateStore).toHaveBeenCalledTimes(1);
      const firstMemory = memoryStores[0]!;
      const firstState = stateStores[0]!;
      const memoryClose = vi.spyOn(firstMemory, 'close');
      const stateClose = vi.spyOn(firstState, 'close');
      const put = await execute(firstDispatcher, 'state_put', {
        namespace: 'reuse', key: 'test', value: { persisted: true },
      });
      expect(put.isError).not.toBe(true);

      // Session reset closes the query, which chains to provider.close().
      firstQuery.close();
      expect(memoryClose).toHaveBeenCalledTimes(1);
      expect(stateClose).toHaveBeenCalledTimes(1);
      expect(() => firstMemory.search('anything')).toThrow(/not open/);
      expect(() => firstState.get('reuse', 'test')).toThrow(/not open/);
      provider.close();
      expect(memoryClose).toHaveBeenCalledTimes(1);
      expect(stateClose).toHaveBeenCalledTimes(1);

      const secondQuery = query();
      try {
        const secondDispatcher = build.mock.results[1]!.value as SessionToolDispatcher;
        expect(makeDefaultMemoryStore).toHaveBeenCalledTimes(2);
        expect(makeDefaultStateStore).toHaveBeenCalledTimes(2);
        expect(memoryStores[1]).not.toBe(firstMemory);
        expect(stateStores[1]).not.toBe(firstState);
        const memory = await execute(secondDispatcher, 'memory_search', { query: 'anything' });
        expect(memory.isError).not.toBe(true);
        const state = await execute(secondDispatcher, 'state_get', { namespace: 'reuse', key: 'test' });
        expect(state.isError).not.toBe(true);
        expect(JSON.parse(state.content).value).toEqual({ persisted: true });
        const write = await execute(secondDispatcher, 'state_put', {
          namespace: 'reuse', key: 'new', value: 'after close',
        });
        expect(write.isError).not.toBe(true);
      } finally {
        secondQuery.close();
      }
    });
  }
});
