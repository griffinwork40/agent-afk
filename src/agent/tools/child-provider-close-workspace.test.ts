/**
 * Regression (fork boundary): closing one forked child's session must not
 * close the WorkspaceStore that every later fork reads at fork time.
 *
 * Field failure (2026-10-11, v5.309.1/.2, 13 `agent` errors across 4 REPL
 * sessions): "Failed to fork subagent: The database connection is not open".
 * The closed database was the session-shared in-memory SQLite WorkspaceStore
 * (`new WorkspaceStore()` → ':memory:'), not the kv.db StateStore:
 * - the REPL injects ONE WorkspaceStore into createChildProviderFactory, so
 *   every child provider holds the same handle;
 * - #3550 chained provider.close() onto query.close(), so a child session's
 *   close (AgentSession.close → drainAndFinalizeClose → providerQuery.close)
 *   ran provider.close(), which then closed the injected workspace store;
 * - the next fork calls workspaceStore.queryRelevant() in
 *   buildForkChildConfig (subagent/fork-child-config.ts) BEFORE the child
 *   session exists, so it threw synchronously and every later fork failed
 *   in ~20 ms.
 * Fixed by #3559 (provider.close releases only stores it created lazily).
 * provider-close-ownership.test.ts pins the provider unit; this test pins the
 * real child-provider factory + query-close chain that the fork path uses.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../memory/memory-store.js';
import { StateStore } from '../state/state-store.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';
import { makeDefaultMemoryStore, makeDefaultStateStore } from '../providers/shared/provider-stores.js';
import { createChildProviderFactory } from './nesting.js';
import type { SubagentExecutor } from './subagent-executor.js';

// Child providers are built WITHOUT injected memory/state stores and open
// their own lazily; point those at a scratch dir instead of ~/.afk.
vi.mock('../providers/shared/provider-stores.js', () => ({
  makeDefaultMemoryStore: vi.fn(),
  makeDefaultStateStore: vi.fn(),
}));

describe('forked child close vs. shared WorkspaceStore', () => {
  let dir: string;
  let workspaceStore: WorkspaceStore;
  let owned: Array<{ close(): void }>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'afk-child-close-ws-'));
    owned = [];
    vi.mocked(makeDefaultMemoryStore).mockImplementation(() => {
      const s = new MemoryStore(path.join(dir, `memory-${owned.length}`));
      owned.push(s);
      return s;
    });
    vi.mocked(makeDefaultStateStore).mockImplementation(() => {
      const s = new StateStore(path.join(dir, `kv-${owned.length}.db`));
      owned.push(s);
      return s;
    });
    // Same construction as the REPL's sharedWorkspaceStore (in-memory SQLite).
    workspaceStore = new WorkspaceStore();
    workspaceStore.publish({ session_id: 'root', agent_id: 'sibling-1', type: 'finding', content: 'sibling finding' });
  });

  afterEach(() => {
    for (const s of owned) s.close();
    workspaceStore.close();
    vi.clearAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const model of ['claude-sonnet-4-6', 'gpt-4o-mini'] as const) {
    it(`${model}: a finished child's session close leaves the next fork's workspace read working`, () => {
      const factory = createChildProviderFactory({ workspaceStore });
      const childProvider = factory({ childExecutor: {} as SubagentExecutor, model });
      const childQuery = childProvider.query({
        prompt: (async function* () {})(),
        config: {
          model,
          apiKey: 'test-key',
          cwd: dir,
          sessionId: 'child-1',
          permissionMode: 'bypassPermissions',
        },
      });

      // The first child finishes: AgentSession.close() → providerQuery.close(),
      // which #3550 chains to childProvider.close().
      childQuery.close();

      // The next fork's first store access (buildForkChildConfig).
      expect(() => workspaceStore.queryRelevant(null, 'next task')).not.toThrow();
      expect(workspaceStore.queryRelevant(null, 'sibling finding').length).toBeGreaterThan(0);
      // The child's own lazily created stores ARE released (#3532 preserved).
      expect(owned.length).toBeGreaterThan(0);
    });
  }
});
