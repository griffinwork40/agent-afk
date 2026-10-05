/**
 * Ownership contract: AgentSession.close() must NEVER dispose an injected
 * `config.provider`.
 *
 * A provider's close() tears down the SQLite stores it holds (memoryStore,
 * workspaceStore, stateStore — see anthropic-direct/provider-runtime.ts
 * `close()` and the openai-compatible provider's `close()`). Those stores are
 * routinely SHARED beyond the session that holds the provider:
 *
 *   - Child providers for subagents / skills / compose nodes are built with the
 *     PARENT's workspaceStore (src/agent/tools/nesting.ts), so the first child
 *     session to close would close the root session's workspace store.
 *   - The daemon factory reuses ONE memoryStore/stateStore across every task
 *     session (src/cli/commands/daemon-session-factory.ts), so task 1's close
 *     would break task 2.
 *   - `afk chat` shares its memory store with the SessionEnd hook.
 *
 * Store ownership stays with whoever created the store; a session only closes
 * its own query. A previous attempt to fix Windows EBUSY in tests added
 * `await this.config.provider?.close?.()` to AgentSession.close(); this test
 * guards against that regression.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ModelProvider, ProviderEvent, ProviderQuery, ProviderQueryArgs } from '../provider.js';
import type { AgentConfig } from '../types.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

function createStubQuery(args: ProviderQueryArgs): ProviderQuery {
  const sessionId = args.config.sessionId ?? 'stub-session';
  async function* generate(): AsyncGenerator<ProviderEvent> {
    yield {
      type: 'session.init',
      info: {
        sessionId,
        model: (args.config.model as string) ?? 'stub',
        permissionMode: args.config.permissionMode ?? 'bypassPermissions',
        cwd: '/tmp/stub',
        tools: [],
        mcpServers: [],
        slashCommands: [],
        skills: [],
        plugins: [],
        apiKeySource: 'user',
        version: '2.1.44',
        outputStyle: 'default',
      },
    };
  }
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue({}),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    accountInfo: vi.fn().mockResolvedValue({}),
    rewindFiles: vi.fn().mockResolvedValue({ canRewind: false }),
    close: vi.fn(),
    [Symbol.asyncIterator]: () => generate(),
  } as unknown as ProviderQuery;
}

/** Provider whose close() is a spy standing in for "closes shared stores". */
class SpyCloseProvider implements ModelProvider {
  readonly name = 'spy-close';
  readonly queries: ProviderQuery[] = [];
  readonly close = vi.fn();
  query(args: ProviderQueryArgs): ProviderQuery {
    const q = createStubQuery(args);
    this.queries.push(q);
    return q;
  }
}

// Import AgentSession after the vi.mock() calls above register.
import { AgentSession } from '../session.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'sonnet', apiKey: 'test-key', ...overrides };
}

describe('AgentSession.close() — provider ownership', () => {
  it('does not call close() on an injected config.provider (its stores may be shared)', async () => {
    const provider = new SpyCloseProvider();
    const session = new AgentSession(makeConfig({ provider }));
    await session.waitForInitialization();

    await session.close();

    // The session's own query IS closed...
    expect(provider.queries).toHaveLength(1);
    expect(provider.queries[0]!.close).toHaveBeenCalled();
    // ...but the provider (and the stores it holds) is left to its owner.
    expect(provider.close).not.toHaveBeenCalled();
  });

  it('leaves a provider shared by two sessions usable after the first closes', async () => {
    const provider = new SpyCloseProvider();
    const first = new AgentSession(makeConfig({ provider }));
    const second = new AgentSession(makeConfig({ provider }));
    await Promise.all([first.waitForInitialization(), second.waitForInitialization()]);

    await first.close();
    expect(provider.close).not.toHaveBeenCalled();

    await second.close();
    expect(provider.close).not.toHaveBeenCalled();
    expect(provider.queries).toHaveLength(2);
  });
});
