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

const makers = [
  ['anthropic-direct', () => new AnthropicDirectProvider({ surface: 'daemon' })],
  ['openai-compatible', () => new OpenAICompatibleProvider({ surface: 'daemon' })],
] as const;

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

// ---------------------------------------------------------------------------
// #3567: stale q1.close() after q2 is created must not kill q2's stores.
//
// Sequence: q1=query() → q1.close() → q2=query() → q1.close() [stale, no-op]
//           → assert q2 memory/state tools work → q2.close() closes once.
// ---------------------------------------------------------------------------
describe('provider stale-close guard (#3567)', () => {
  let dir: string;
  let memoryStores: MemoryStore[];
  let stateStores: StateStore[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'afk-stale-close-'));
    memoryStores = [];
    stateStores = [];
    vi.mocked(makeDefaultMemoryStore).mockImplementation(() => {
      const store = new MemoryStore(path.join(dir, `memory-${memoryStores.length}`));
      memoryStores.push(store);
      return store;
    });
    vi.mocked(makeDefaultStateStore).mockImplementation(() => {
      const store = new StateStore(path.join(dir, `kv-${stateStores.length}.db`));
      stateStores.push(store);
      return store;
    });
  });

  afterEach(() => {
    for (const store of memoryStores) { try { store.close(); } catch { /* already closed */ } }
    for (const store of stateStores) { try { store.close(); } catch { /* already closed */ } }
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [providerName, make] of makers) {
    it(`${providerName}: q1.close() before q2 created, then stale re-close is no-op`, async () => {
      const provider = make();
      const build = vi.spyOn(provider as unknown as {
        buildDispatcher: (...args: unknown[]) => SessionToolDispatcher;
      }, 'buildDispatcher');

      const makeQuery = (sessionId: string) => provider.query({
        prompt: (async function* () {})(),
        config: {
          model: providerName === 'anthropic-direct' ? 'claude-sonnet-4-6' : 'gpt-4o-mini',
          apiKey: 'test-key',
          cwd: dir,
          sessionId,
          permissionMode: 'bypassPermissions',
        },
      });
      const execute = (dispatcher: SessionToolDispatcher, tool: string, input: unknown) =>
        dispatcher.execute({ id: tool, name: tool, input, signal: new AbortController().signal });

      // Step 1: open q1, write state through it.
      const q1 = makeQuery('stale-q1');
      const d1 = build.mock.results[0]!.value as SessionToolDispatcher;
      const w1 = await execute(d1, 'state_put', {
        namespace: 'stale', key: 'slot', value: { from: 'q1' },
      });
      expect(w1.isError).not.toBe(true);

      // Step 2: close q1 — provider.close() fires, stores released.
      q1.close();
      expect(memoryStores).toHaveLength(1);
      expect(stateStores).toHaveLength(1);

      // Step 3: open q2 — provider reopens fresh stores.
      const q2 = makeQuery('stale-q2');
      const d2 = build.mock.results[1]!.value as SessionToolDispatcher;
      expect(memoryStores).toHaveLength(2);
      expect(stateStores).toHaveLength(2);

      const activeMemory = memoryStores[1]!;
      const activeState = stateStores[1]!;
      const memSpy = vi.spyOn(activeMemory, 'close');
      const stateSpy = vi.spyOn(activeState, 'close');

      // Step 4: stale q1.close() again — must be a no-op; q2's stores survive.
      q1.close();
      expect(memSpy).not.toHaveBeenCalled();
      expect(stateSpy).not.toHaveBeenCalled();

      // Step 5: q2's memory and state tools still work.
      const mem = await execute(d2, 'memory_search', { query: 'anything' });
      expect(mem.isError).not.toBe(true);

      const st = await execute(d2, 'state_get', { namespace: 'stale', key: 'slot' });
      expect(st.isError).not.toBe(true);

      const stWrite = await execute(d2, 'state_put', {
        namespace: 'stale', key: 'slot2', value: { from: 'q2' },
      });
      expect(stWrite.isError).not.toBe(true);

      // Step 6: q2.close() releases q2's stores exactly once.
      q2.close();
      expect(memSpy).toHaveBeenCalledTimes(1);
      expect(stateSpy).toHaveBeenCalledTimes(1);
    });
  }
});
