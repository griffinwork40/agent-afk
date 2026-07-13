/**
 * Tests for named-agent (`agent_type`) dispatch through SubagentExecutor.
 *
 * Covers: resolution hit/miss, the subagent_type alias, system-prompt
 * substitution, model precedence (call-site > def > inherit > policy),
 * maxTurns precedence, allowlist enforcement reaching the child provider
 * factory, cage intersection, the depth-cap restricted-provider fallback,
 * render labels, and describeAgentTool discovery.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const appendRoutingDecision = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision }));

const mockResolveCredentialForModel = vi.hoisted(() =>
  vi.fn((_model: string | undefined) => 'resolved-test-credential' as string | undefined),
);
vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: mockResolveCredentialForModel,
  loadAnthropicCredential: vi.fn(() => 'resolved-test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

import type { SubagentHandle, SubagentResult } from '../subagent.js';
import type { ToolCall } from './types.js';
import type { ModelProvider } from '../provider.js';
import { SubagentExecutor, type SubagentExecutorContext } from './subagent-executor.js';
import { agentTool } from './schemas.js';
import type { AgentRegistry, RegisteredAgent } from '../agents/index.js';

function mockHandle(): Partial<SubagentHandle> {
  return {
    id: 'named-handle',
    status: 'succeeded' as SubagentHandle['status'],
    runToResult: vi.fn().mockResolvedValue({
      id: 'named-handle',
      status: 'succeeded',
      message: { role: 'assistant', content: 'ok', timestamp: new Date() },
    } as SubagentResult),
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCall(input: Record<string, unknown>): ToolCall {
  return {
    id: 'call-1',
    name: 'agent',
    input,
    signal: new AbortController().signal,
  };
}

function makeRegistry(agents: RegisteredAgent[]): AgentRegistry {
  return new Map(agents.map((a) => [a.name, a]));
}

const RESEARCH: RegisteredAgent = {
  name: 'research-agent',
  source: 'builtin',
  definition: {
    description: 'Read-only research sub-agent',
    prompt: 'You are the research agent system prompt.',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  },
};

const GIT: RegisteredAgent = {
  name: 'git-investigator',
  source: 'builtin',
  definition: {
    description: 'Read-only git specialist',
    prompt: 'You are the git investigator.',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    model: 'sonnet',
  },
  bashReadOnly: true,
};

const INHERIT_AGENT: RegisteredAgent = {
  name: 'inheritor',
  source: 'user',
  definition: {
    description: 'inherits model',
    prompt: 'inherit prompt',
    model: 'inherit',
    maxTurns: 4,
    maxToolUseIterations: 7,
  },
};

// Mirrors the real builtin research-agent's scoped nesting grant
// (`Agent(git-investigator)`): read-only leaf tools PLUS a single scoped
// dispatch. Used to exercise the nested-dispatch scope gate end-to-end.
const RESEARCH_NESTER: RegisteredAgent = {
  name: 'research-nester',
  source: 'builtin',
  definition: {
    description: 'research that may nest git-investigator',
    prompt: 'You may dispatch git-investigator.',
    tools: ['Read', 'Grep', 'Glob', 'Agent(git-investigator)'],
  },
};

describe('SubagentExecutor named-agent dispatch', () => {
  let forkSubagent: ReturnType<typeof vi.fn>;
  let factoryCalls: Array<Record<string, unknown>>;
  let childProviderFactory: (args: never) => ModelProvider;

  beforeEach(() => {
    forkSubagent = vi.fn().mockResolvedValue(mockHandle());
    factoryCalls = [];
    childProviderFactory = ((args: Record<string, unknown>) => {
      factoryCalls.push(args);
      return { name: 'stub-provider' } as unknown as ModelProvider;
    }) as unknown as (args: never) => ModelProvider;
  });

  function makeExecutor(overrides?: Partial<SubagentExecutorContext>): SubagentExecutor {
    const ctx: SubagentExecutorContext = {
      subagentManager: { forkSubagent, setCwd: vi.fn(), list: () => [] } as never,
      parentSession: {
        sessionId: 'parent-1',
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      } as never,
      defaultConfig: { apiKey: 'k', systemPrompt: 'BASE PROMPT' },
      depth: 0,
      childProviderFactory: childProviderFactory as never,
      agentRegistry: makeRegistry([RESEARCH, GIT, INHERIT_AGENT]),
      parentModel: 'opus',
      ...overrides,
    };
    return new SubagentExecutor(ctx);
  }

  it('fails fast with the available list on unknown agent_type', async () => {
    const executor = makeExecutor();
    const result = await executor.execute(
      makeCall({ prompt: 'x', agent_type: 'nope' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Agent type "nope" not found');
    expect(result.content).toContain('git-investigator');
    expect(result.content).toContain('research-agent');
    expect(forkSubagent).not.toHaveBeenCalled();
  });

  it('surfaces fail-closed dropped tool tokens on stderr (default-visible, not AFK_DEBUG-gated)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const executor = makeExecutor({
        agentRegistry: makeRegistry([
          {
            name: 'misconfigured',
            source: 'user',
            definition: {
              description: 'declares an unknown tool token',
              prompt: 'p',
              tools: ['Read', 'NotARealToolToken'],
            },
          },
        ]),
      });
      await executor.execute(makeCall({ prompt: 'x', agent_type: 'misconfigured' }));
      const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(emitted).toContain('dropped fail-closed');
      expect(emitted).toContain('misconfigured');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports (none) when no registry is wired', async () => {
    const executor = makeExecutor({ agentRegistry: undefined });
    const result = await executor.execute(
      makeCall({ prompt: 'x', agent_type: 'research-agent' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('(none)');
  });

  it('substitutes the definition prompt, enforces the mapped allowlist, and labels the fork', async () => {
    const executor = makeExecutor();
    await executor.execute(makeCall({ prompt: 'go', agent_type: 'research-agent' }));

    expect(forkSubagent).toHaveBeenCalledTimes(1);
    const forkArgs = forkSubagent.mock.calls[0]?.[0];
    expect(forkArgs.config.systemPrompt).toBe('You are the research agent system prompt.');
    expect(forkArgs.agentType).toBe('research-agent');

    // Allowlist reaches the child provider factory in AFK runtime names.
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]?.['allowedTools']).toEqual([
      'read_file',
      'grep',
      'glob',
      'web_scrape',
    ]);
    expect(factoryCalls[0]?.['readOnlyBash']).toBeUndefined();
  });

  it('accepts subagent_type as an alias', async () => {
    const executor = makeExecutor();
    await executor.execute(makeCall({ prompt: 'go', subagent_type: 'research-agent' }));
    const forkArgs = forkSubagent.mock.calls[0]?.[0];
    expect(forkArgs.agentType).toBe('research-agent');
  });

  it('applies bash: read-only as readOnlyBash on the child provider', async () => {
    const executor = makeExecutor();
    await executor.execute(makeCall({ prompt: 'go', agent_type: 'git-investigator' }));
    expect(factoryCalls[0]?.['allowedTools']).toEqual(['bash', 'read_file', 'grep', 'glob']);
    expect(factoryCalls[0]?.['readOnlyBash']).toBe(true);
  });

  it('model precedence: def model > policy default; call-site wins over def', async () => {
    const executor = makeExecutor({ defaultSubagentModel: 'haiku' });
    await executor.execute(makeCall({ prompt: 'go', agent_type: 'git-investigator' }));
    expect(forkSubagent.mock.calls[0]?.[0].config.model).toBe('sonnet');

    forkSubagent.mockClear();
    await executor.execute(
      makeCall({ prompt: 'go', agent_type: 'git-investigator', model: 'haiku' }),
    );
    expect(forkSubagent.mock.calls[0]?.[0].config.model).toBe('haiku');
  });

  it('model: inherit resolves to the dispatching session model', async () => {
    const executor = makeExecutor({ defaultSubagentModel: 'haiku' });
    await executor.execute(makeCall({ prompt: 'go', agent_type: 'inheritor' }));
    expect(forkSubagent.mock.calls[0]?.[0].config.model).toBe('opus');
  });

  it('named dispatch with omitted model inherits the parent model (CC parity)', async () => {
    const executor = makeExecutor({ defaultSubagentModel: 'haiku' });
    await executor.execute(makeCall({ prompt: 'go', agent_type: 'research-agent' }));
    expect(forkSubagent.mock.calls[0]?.[0].config.model).toBe('opus');
  });

  it('unnamed dispatch keeps the policy default chain', async () => {
    const executor = makeExecutor({ defaultSubagentModel: 'haiku' });
    await executor.execute(makeCall({ prompt: 'go' }));
    expect(forkSubagent.mock.calls[0]?.[0].config.model).toBe('haiku');
  });

  it('maxTurns: def value applies as default; explicit call-site wins', async () => {
    const executor = makeExecutor();
    await executor.execute(makeCall({ prompt: 'go', agent_type: 'inheritor' }));
    expect(forkSubagent.mock.calls[0]?.[0].config.maxTurns).toBe(4);

    forkSubagent.mockClear();
    await executor.execute(
      makeCall({ prompt: 'go', agent_type: 'inheritor', max_turns: 22 }),
    );
    expect(forkSubagent.mock.calls[0]?.[0].config.maxTurns).toBe(22);
  });

  it('maxToolUseIterations: def value applies as default; explicit call-site wins', async () => {
    const executor = makeExecutor();
    await executor.execute(makeCall({ prompt: 'go', agent_type: 'inheritor' }));
    expect(forkSubagent.mock.calls[0]?.[0].config.maxToolUseIterations).toBe(7);

    forkSubagent.mockClear();
    await executor.execute(
      makeCall({ prompt: 'go', agent_type: 'inheritor', max_tool_use_iterations: 30 }),
    );
    expect(forkSubagent.mock.calls[0]?.[0].config.maxToolUseIterations).toBe(30);
  });

  it('intersects the definition allowlist with an existing cage', async () => {
    const executor = makeExecutor({
      allowedTools: ['read_file', 'glob', 'bash'],
      readOnlyBash: true,
    });
    await executor.execute(makeCall({ prompt: 'go', agent_type: 'research-agent' }));
    // def {read_file,grep,glob,web_scrape} ∩ cage {read_file,glob,bash}
    expect(factoryCalls[0]?.['allowedTools']).toEqual(['read_file', 'glob']);
    expect(factoryCalls[0]?.['readOnlyBash']).toBe(true);
  });

  it('falls back to a restricted provider at the depth cap instead of failing open', async () => {
    const executor = makeExecutor({ depth: 3, maxDepth: 3 });
    await executor.execute(makeCall({ prompt: 'go', agent_type: 'research-agent' }));
    expect(factoryCalls).toHaveLength(0); // factory not used at cap
    const forkArgs = forkSubagent.mock.calls[0]?.[0];
    // A provider override IS present (the restricted fallback), not undefined.
    expect(forkArgs.config.provider).toBeDefined();
  });

  it('unnamed dispatch remains unchanged (no provider restriction, base prompt)', async () => {
    const executor = makeExecutor();
    await executor.execute(makeCall({ prompt: 'plain dispatch' }));
    const forkArgs = forkSubagent.mock.calls[0]?.[0];
    expect(forkArgs.config.systemPrompt).toBe('BASE PROMPT');
    expect(factoryCalls[0]?.['allowedTools']).toBeUndefined();
    expect(forkArgs.agentType).toBe('plain dispatch');
  });

  describe('nested-dispatch scope gate', () => {
    it('allows an in-scope agent_type dispatch', async () => {
      const executor = makeExecutor({ nestedAgentAllowlist: ['git-investigator'] });
      const result = await executor.execute(
        makeCall({ prompt: 'go', agent_type: 'git-investigator' }),
      );
      expect(result.isError).toBeFalsy();
      expect(forkSubagent).toHaveBeenCalledTimes(1);
    });

    it('rejects an out-of-scope agent_type without forking', async () => {
      const executor = makeExecutor({ nestedAgentAllowlist: ['git-investigator'] });
      // research-agent IS in the registry (resolves fine) but is out of scope.
      const result = await executor.execute(
        makeCall({ prompt: 'go', agent_type: 'research-agent' }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('may only dispatch');
      expect(result.content).toContain('git-investigator');
      expect(result.content).toContain('out of scope');
      expect(forkSubagent).not.toHaveBeenCalled();
    });

    it('rejects a bare dispatch (no agent_type) without forking', async () => {
      const executor = makeExecutor({ nestedAgentAllowlist: ['git-investigator'] });
      const result = await executor.execute(makeCall({ prompt: 'go' }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('bare dispatch');
      expect(forkSubagent).not.toHaveBeenCalled();
    });

    it('rejects EVERY dispatch under an empty deny-all allowlist ([] from Agent())', async () => {
      // An `Agent()` grant resolves to nestedAgentTypes [] → nestedAgentAllowlist [].
      // Presence (not length) gates, so even a registered, in-registry agent_type
      // is rejected — the fail-closed default the medium finding fixed.
      const executor = makeExecutor({ nestedAgentAllowlist: [] });
      const result = await executor.execute(
        makeCall({ prompt: 'go', agent_type: 'research-agent' }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not permitted to dispatch any nested agents');
      expect(forkSubagent).not.toHaveBeenCalled();
    });

    it('rejects a bare dispatch under an empty deny-all allowlist', async () => {
      const executor = makeExecutor({ nestedAgentAllowlist: [] });
      const result = await executor.execute(makeCall({ prompt: 'go' }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not permitted to dispatch any nested agents');
      expect(forkSubagent).not.toHaveBeenCalled();
    });

    it('does not restrict dispatch when no allowlist is set (top-level executor)', async () => {
      const executor = makeExecutor();
      const result = await executor.execute(
        makeCall({ prompt: 'go', agent_type: 'research-agent' }),
      );
      expect(result.isError).toBeFalsy();
      expect(forkSubagent).toHaveBeenCalledTimes(1);
    });

    it('grants the agent tool to a scoped agent (research-nester can dispatch)', async () => {
      const executor = makeExecutor({
        agentRegistry: makeRegistry([RESEARCH_NESTER, GIT]),
      });
      await executor.execute(makeCall({ prompt: 'go', agent_type: 'research-nester' }));
      // The dispatch grant reaches the child provider — `agent` is present.
      expect(factoryCalls[0]?.['allowedTools']).toEqual(['read_file', 'grep', 'glob', 'agent']);
    });

    it('threads the scope into the dispatched agent\'s own executor (end-to-end)', async () => {
      const executor = makeExecutor({
        agentRegistry: makeRegistry([RESEARCH_NESTER, GIT]),
      });
      await executor.execute(makeCall({ prompt: 'go', agent_type: 'research-nester' }));
      // The child provider factory received research-nester's OWN executor.
      const childExecutor = factoryCalls[0]?.['childExecutor'] as SubagentExecutor | undefined;
      expect(childExecutor).toBeDefined();
      // When research-nester attempts a BARE dispatch, its threaded scope gates
      // it — proving the escalation path (unrestricted grandchild) is closed.
      // The gate returns before any real fork, so this is safe against the
      // child's real (non-mocked) SubagentManager.
      const nested = await childExecutor!.execute(makeCall({ prompt: 'escalate' }));
      expect(nested.isError).toBe(true);
      expect(nested.content).toContain('may only dispatch');
      expect(nested.content).toContain('git-investigator');
    });
  });

  describe('describeAgentTool', () => {
    it('returns the static def without a registry', () => {
      const executor = makeExecutor({ agentRegistry: undefined });
      expect(executor.describeAgentTool()).toBe(agentTool);
    });

    it('advertises registry types with a registry', () => {
      const executor = makeExecutor();
      const def = executor.describeAgentTool();
      expect(def.description).toContain('Available agent types');
      expect(def.description).toContain('research-agent');
      expect(def.input_schema.properties).toHaveProperty('agent_type');
    });
  });
});
