/**
 * Regression: provider.close() must not close caller-injected stores.
 *
 * The REPL builds ONE memory/state/workspace store and injects it into the
 * root provider and every forked child provider. #3550 made session close call
 * provider.close(), which closed those shared handles; the first child to
 * finish then broke every later fork with "The database connection is not
 * open" (fork-child-config queries the workspace store at fork time).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory/memory-store.js';
import { StateStore } from '../state/state-store.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';
import { AnthropicDirectProvider } from './anthropic-direct/provider-runtime.js';
import { OpenAICompatibleProvider } from './openai-compatible/index.js';

describe('provider.close() store ownership', () => {
  let dir: string;
  let memoryStore: MemoryStore;
  let stateStore: StateStore;
  let workspaceStore: WorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'afk-close-ownership-'));
    memoryStore = new MemoryStore(path.join(dir, 'memory'));
    stateStore = new StateStore(path.join(dir, 'kv.db'));
    workspaceStore = new WorkspaceStore(path.join(dir, 'workspace.db'));
  });

  afterEach(() => {
    memoryStore.close();
    stateStore.close();
    workspaceStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makers = [
    ['anthropic-direct', (o: object) => new AnthropicDirectProvider(o)],
    ['openai-compatible', (o: object) => new OpenAICompatibleProvider(o)],
  ] as const;

  for (const [name, make] of makers) {
    it(`${name}: injected stores stay usable after close()`, () => {
      const provider = make({ memoryStore, stateStore, workspaceStore });
      provider.close();
      // A sibling fork reusing the shared stores must still work.
      expect(() => stateStore.put('ns', 'k', { v: 1 })).not.toThrow();
      expect(stateStore.get('ns', 'k')).not.toBeNull();
      expect(() => memoryStore.search('anything')).not.toThrow();
      expect(() => workspaceStore.queryAll('session')).not.toThrow();
    });
  }
});
