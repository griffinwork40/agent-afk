/**
 * Wave 0 — forwarding contract for the SDK method wrappers on AgentSession.
 *
 * These tests pin down the minimal invariant every wrapper must satisfy:
 *   1. It calls the corresponding method on the underlying ProviderQuery.
 *   2. It returns whatever the provider returns, unchanged.
 *
 * If someone later adds business logic on top of a wrapper (caching, sampling,
 * etc.) they will need to update these tests — which is exactly the prompt
 * we want, because such changes are behavior changes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ModelProvider,
  ProviderEvent,
  ProviderQuery,
  ProviderQueryArgs,
} from '../provider.js';
import type { AgentConfig } from '../types.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

interface StubQuery extends ProviderQuery {
  readonly calls: {
    supportedAgents: number;
    getContextUsage: number;
  };
}

const AGENTS_STUB = [{ agentType: 'research-agent', source: 'plugin', tokens: 100 }];
const CONTEXT_STUB = {
  tools: [{ name: 'Bash', tokens: 1200 }],
  agents: [],
  systemPromptSections: [{ name: 'core', tokens: 800 }],
  slashCommands: { totalCommands: 5, includedCommands: 5, tokens: 100 },
  skills: {
    totalSkills: 7,
    includedSkills: 7,
    tokens: 200,
    skillFrontmatter: [],
  },
  isAutoCompactEnabled: true,
  autoCompactThreshold: 150_000,
  apiUsage: {
    input_tokens: 500,
    output_tokens: 250,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

function createStubQuery(args: ProviderQueryArgs): StubQuery {
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
  const calls = { supportedAgents: 0, getContextUsage: 0 };
  return {
    calls,
    interrupt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn(async () => {
      calls.supportedAgents += 1;
      return AGENTS_STUB as unknown as Awaited<ReturnType<ProviderQuery['supportedAgents']>>;
    }),
    getContextUsage: vi.fn(async () => {
      calls.getContextUsage += 1;
      return CONTEXT_STUB as unknown as Awaited<ReturnType<ProviderQuery['getContextUsage']>>;
    }),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    accountInfo: vi.fn().mockResolvedValue({}),
    rewindFiles: vi.fn().mockResolvedValue({ canRewind: false }),
    close: vi.fn(),
    [Symbol.asyncIterator]: () => generate(),
  };
}

class StubProvider implements ModelProvider {
  readonly name = 'stub';
  readonly handles: StubQuery[] = [];
  query(args: ProviderQueryArgs): ProviderQuery {
    const handle = createStubQuery(args);
    this.handles.push(handle);
    return handle;
  }
}

// Import AgentSession after the vi.mock() calls above register.
import { AgentSession } from '../session.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'sonnet', apiKey: 'test-key', ...overrides };
}

describe('AgentSession — Wave 0 wrappers', () => {
  let provider: StubProvider;

  beforeEach(() => {
    provider = new StubProvider();
  });

  describe('supportedAgents()', () => {
    it('forwards to the underlying ProviderQuery', async () => {
      const session = new AgentSession(makeConfig({ provider }));
      await session.waitForInitialization();

      const result = await session.supportedAgents();
      expect(provider.handles[0]!.calls.supportedAgents).toBe(1);
      expect(result).toEqual(AGENTS_STUB);
      await session.close();
    });

    it('propagates rejection unchanged', async () => {
      const failing = new StubProvider();
      const session = new AgentSession(makeConfig({ provider: failing }));
      await session.waitForInitialization();
      (failing.handles[0]!.supportedAgents as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('subprocess not ready'),
      );

      await expect(session.supportedAgents()).rejects.toThrow('subprocess not ready');
      await session.close();
    });
  });

  describe('getContextUsage()', () => {
    it('forwards to the underlying ProviderQuery', async () => {
      const session = new AgentSession(makeConfig({ provider }));
      await session.waitForInitialization();

      const result = await session.getContextUsage();
      expect(provider.handles[0]!.calls.getContextUsage).toBe(1);
      expect(result).toEqual(CONTEXT_STUB);
      await session.close();
    });

    it('propagates rejection unchanged', async () => {
      const failing = new StubProvider();
      const session = new AgentSession(makeConfig({ provider: failing }));
      await session.waitForInitialization();
      (failing.handles[0]!.getContextUsage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('no context yet'),
      );

      await expect(session.getContextUsage()).rejects.toThrow('no context yet');
      await session.close();
    });
  });
});
