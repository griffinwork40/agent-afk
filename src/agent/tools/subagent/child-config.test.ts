/**
 * Direct unit tests for `buildChildConfig` — child AgentConfig construction +
 * nesting/depth wiring.
 *
 * Follow-up to #443. `buildChildConfig` depends on manager/provider/credential
 * resolution, but its DETERMINISTIC behavior is unit-testable by:
 *   - injecting `resolveApiKeyForModel` (a first-class parameter) so the live
 *     keychain/credential resolver is never touched;
 *   - passing stub `createChildExecutor` / `childProviderFactory` callbacks.
 *
 * Scope (intentionally narrow — model/credential anti-leak and depth-2 cwd
 * propagation are already covered transitively in `subagent-executor.test.ts`):
 *   1. turn-budget resolution (explicit vs. named-agent frontmatter vs. default)
 *   2. depth wiring (`depth + 1`, `maxDepth`) into the child config
 *   3. systemPrompt selection (named-agent body vs. parent base prompt)
 *   4. named-agent tool-access intersection (fail-closed narrowing against a cage)
 *   5. cwd threading + omission
 *   6. model resolution legs (named fixed / named `inherit` / unnamed fallback)
 *   7. nesting skip at maxDepth (no childManager)
 *   8. restricted-provider fallback at the depth cap
 *
 * Deferred (covered transitively, not re-implemented here): the full
 * cross-provider credential anti-leak matrix and depth-2+ childManager cwd
 * inheritance — see `subagent-executor.test.ts` `resolveApiKeyForModel` and
 * `parentId attribution` describe blocks.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildChildConfig, type BuildChildConfigArgs } from './child-config.js';
import type { AgentInput } from './input-parse.js';
import type { RegisteredAgent } from '../../agents/index.js';
import type { ModelProvider } from '../../provider.js';
import type { SubagentExecutor, SubagentExecutorContext } from '../subagent-executor.js';

/** A parsed AgentInput with the fields buildChildConfig reads. */
function parsed(overrides?: Partial<AgentInput>): AgentInput {
  return {
    prompt: 'do the thing',
    max_turns: 10,
    max_turns_explicit: false,
    max_tool_use_iterations: 0,
    max_tool_use_iterations_explicit: false,
    id_prefix: 'agent-tool',
    mode: 'foreground',
    ...overrides,
  };
}

/** A registered named agent with a definition. */
function namedAgent(
  definition: Partial<RegisteredAgent['definition']>,
  extra?: Partial<RegisteredAgent>,
): RegisteredAgent {
  return {
    name: 'test-agent',
    source: 'user',
    definition: {
      description: 'a test agent',
      prompt: 'You are a test agent.',
      ...definition,
    },
    ...extra,
  };
}

/** A stub child executor — buildChildConfig only stores the reference. */
function stubChildExecutor(): SubagentExecutor {
  return {} as unknown as SubagentExecutor;
}

/**
 * Base args. `resolveApiKeyForModel` is injected so the live credential
 * resolver is never called; `createChildExecutor` is a no-op stub.
 */
function baseArgs(overrides?: Partial<BuildChildConfigArgs>): BuildChildConfigArgs {
  const signal = new AbortController().signal;
  return {
    parsed: parsed(),
    namedAgent: undefined,
    depth: 0,
    maxDepth: 3,
    currentCwd: undefined,
    signal,
    defaultConfig: {
      apiKey: 'parent-anthropic-key',
      systemPrompt: 'parent base prompt',
      baseUrl: undefined,
      openaiBaseUrl: undefined,
    },
    resolveApiKeyForModel: vi.fn((_m: string) => 'child-resolved-key'),
    createChildExecutor: vi.fn((_ctx: SubagentExecutorContext) => stubChildExecutor()),
    ...overrides,
  };
}

describe('buildChildConfig', () => {
  describe('turn budget (effectiveMaxTurns)', () => {
    it('uses the parse-time default when no named agent and not explicit', () => {
      const { childConfig } = buildChildConfig(baseArgs({ parsed: parsed({ max_turns: 10 }) }));
      expect(childConfig.maxTurns).toBe(10);
    });

    it('uses an explicit per-call max_turns even when a named agent has maxTurns', () => {
      const { childConfig } = buildChildConfig(
        baseArgs({
          parsed: parsed({ max_turns: 7, max_turns_explicit: true }),
          namedAgent: namedAgent({ maxTurns: 30 }),
        }),
      );
      expect(childConfig.maxTurns).toBe(7);
    });

    it("uses a named agent's maxTurns frontmatter when max_turns is not explicit", () => {
      const { childConfig } = buildChildConfig(
        baseArgs({
          parsed: parsed({ max_turns: 10, max_turns_explicit: false }),
          namedAgent: namedAgent({ maxTurns: 30 }),
        }),
      );
      expect(childConfig.maxTurns).toBe(30);
    });

    it('preserves a named agent maxTurns above the former cap unchanged (999 stays 999)', () => {
      // #448 removed the old upper clamp — effectiveMaxTurns floors to ≥1 but
      // imposes no ceiling (child-config.ts effectiveMaxTurns).
      const { childConfig } = buildChildConfig(
        baseArgs({ namedAgent: namedAgent({ maxTurns: 999 }) }),
      );
      expect(childConfig.maxTurns).toBe(999);
    });

    it('clamps a named agent maxTurns below 1 up to 1', () => {
      const { childConfig } = buildChildConfig(
        baseArgs({ namedAgent: namedAgent({ maxTurns: 0 }) }),
      );
      expect(childConfig.maxTurns).toBe(1);
    });

    it('floors a fractional named agent maxTurns', () => {
      const { childConfig } = buildChildConfig(
        baseArgs({ namedAgent: namedAgent({ maxTurns: 12.9 }) }),
      );
      expect(childConfig.maxTurns).toBe(12);
    });
  });

  describe('depth wiring', () => {
    it('sets childConfig.depth to depth + 1', () => {
      const { childConfig } = buildChildConfig(baseArgs({ depth: 2, maxDepth: 5 }));
      expect(childConfig.depth).toBe(3);
    });

    it('propagates maxDepth to the child config', () => {
      const { childConfig } = buildChildConfig(baseArgs({ depth: 0, maxDepth: 5 }));
      expect(childConfig.maxDepth).toBe(5);
    });
  });

  describe('systemPrompt selection', () => {
    it('uses the parent base prompt for an unnamed dispatch', () => {
      const { childConfig } = buildChildConfig(baseArgs({ namedAgent: undefined }));
      expect(childConfig.systemPrompt).toBe('parent base prompt');
    });

    it("uses the named agent's definition prompt (markdown body) for a named dispatch", () => {
      const { childConfig } = buildChildConfig(
        baseArgs({ namedAgent: namedAgent({ prompt: 'You are the research agent.' }) }),
      );
      expect(childConfig.systemPrompt).toBe('You are the research agent.');
    });
  });

  describe('model resolution', () => {
    it("falls back to 'sonnet' for an unnamed dispatch with no defaults", () => {
      const { childConfig } = buildChildConfig(baseArgs({ defaultSubagentModel: undefined }));
      expect(childConfig.model).toBe('sonnet');
    });

    it('uses defaultSubagentModel when parsed.model and named model are absent', () => {
      const { childConfig } = buildChildConfig(baseArgs({ defaultSubagentModel: 'haiku' }));
      expect(childConfig.model).toBe('haiku');
    });

    it('parsed.model wins over defaultSubagentModel and named model', () => {
      const { childConfig } = buildChildConfig(
        baseArgs({
          parsed: parsed({ model: 'opus' }),
          namedAgent: namedAgent({ model: 'haiku' }),
          defaultSubagentModel: 'sonnet',
        }),
      );
      expect(childConfig.model).toBe('opus');
    });

    it("uses a named agent's fixed model over defaultSubagentModel", () => {
      const { childConfig } = buildChildConfig(
        baseArgs({
          namedAgent: namedAgent({ model: 'haiku' }),
          defaultSubagentModel: 'sonnet',
        }),
      );
      expect(childConfig.model).toBe('haiku');
    });

    it("resolves a named agent's model: 'inherit' to parentModel", () => {
      const { childConfig } = buildChildConfig(
        baseArgs({
          namedAgent: namedAgent({ model: 'inherit' }),
          parentModel: 'opus',
        }),
      );
      expect(childConfig.model).toBe('opus');
    });

    it("falls through to the policy chain when named model is 'inherit' but parentModel is unset", () => {
      const { childConfig } = buildChildConfig(
        baseArgs({
          namedAgent: namedAgent({ model: 'inherit' }),
          parentModel: undefined,
          defaultSubagentModel: 'haiku',
        }),
      );
      expect(childConfig.model).toBe('haiku');
    });

    it('treats an omitted named model as inherit (uses parentModel)', () => {
      const { childConfig } = buildChildConfig(
        baseArgs({
          namedAgent: namedAgent({}), // no model field
          parentModel: 'opus',
        }),
      );
      expect(childConfig.model).toBe('opus');
    });
  });

  describe('cwd threading', () => {
    it('threads parsed.cwd into childConfig.cwd when present', () => {
      const { childConfig } = buildChildConfig(
        baseArgs({ parsed: parsed({ cwd: '/tmp/wt/feat-x' }) }),
      );
      expect(childConfig.cwd).toBe('/tmp/wt/feat-x');
    });

    it('omits the cwd key entirely when parsed.cwd is absent (parent fallback preserved)', () => {
      const { childConfig } = buildChildConfig(baseArgs({ parsed: parsed() }));
      // Own-key absence, not just undefined value — SubagentManager's parentCwd
      // fallback engages only when the key is truly absent.
      expect(Object.prototype.hasOwnProperty.call(childConfig, 'cwd')).toBe(false);
    });
  });

  describe('credential wiring (deterministic slice)', () => {
    it('resolves the child apiKey via the injected resolver, keyed by the child model', () => {
      const resolveApiKeyForModel = vi.fn((_m: string) => 'child-resolved-key');
      const { childConfig } = buildChildConfig(
        baseArgs({ parsed: parsed({ model: 'sonnet' }), resolveApiKeyForModel }),
      );
      expect(resolveApiKeyForModel).toHaveBeenCalledWith('sonnet');
      expect(childConfig.apiKey).toBe('child-resolved-key');
    });
  });

  describe('nesting wiring', () => {
    function mockProvider(): ModelProvider {
      return { name: 'test-provider', query: vi.fn() };
    }

    it('builds a child manager + calls the provider factory when depth < maxDepth and a factory is wired', () => {
      const childProviderFactory = vi.fn(() => mockProvider());
      const createChildExecutor = vi.fn((_ctx: SubagentExecutorContext) => stubChildExecutor());
      const { childConfig, childManager, childParentSession } = buildChildConfig(
        baseArgs({ depth: 0, maxDepth: 3, childProviderFactory, createChildExecutor }),
      );

      expect(childManager).toBeDefined();
      expect(childParentSession).toBeDefined();
      expect(createChildExecutor).toHaveBeenCalledTimes(1);
      expect(childProviderFactory).toHaveBeenCalledTimes(1);
      expect(childConfig.provider).toBeDefined();
    });

    it('passes depth + 1 and maxDepth into the recursive child executor ctx', () => {
      let capturedCtx: SubagentExecutorContext | undefined;
      const childProviderFactory = vi.fn(() => mockProvider());
      const createChildExecutor = vi.fn((ctx: SubagentExecutorContext) => {
        capturedCtx = ctx;
        return stubChildExecutor();
      });
      buildChildConfig(
        baseArgs({ depth: 1, maxDepth: 4, childProviderFactory, createChildExecutor }),
      );
      expect(capturedCtx).toBeDefined();
      expect(capturedCtx!.depth).toBe(2);
      expect(capturedCtx!.maxDepth).toBe(4);
    });

    it('forwards currentCwd to the child manager (depth-2 fork inheritance)', () => {
      const childProviderFactory = vi.fn(() => mockProvider());
      const { childManager } = buildChildConfig(
        baseArgs({
          depth: 0,
          maxDepth: 3,
          currentCwd: '/tmp/wt/feat-y',
          childProviderFactory,
        }),
      );
      const mgr = childManager as unknown as { parentCwd: string | undefined };
      expect(mgr.parentCwd).toBe('/tmp/wt/feat-y');
    });

    it('skips nesting (no child manager, no provider) at the depth cap', () => {
      const childProviderFactory = vi.fn(() => mockProvider());
      const { childConfig, childManager, childParentSession } = buildChildConfig(
        baseArgs({ depth: 3, maxDepth: 3, childProviderFactory }),
      );
      expect(childManager).toBeUndefined();
      expect(childParentSession).toBeUndefined();
      expect(childProviderFactory).not.toHaveBeenCalled();
      expect(childConfig.provider).toBeUndefined();
    });

    it('skips nesting when no provider factory is wired', () => {
      const { childConfig, childManager } = buildChildConfig(
        baseArgs({ depth: 0, maxDepth: 3, childProviderFactory: undefined }),
      );
      expect(childManager).toBeUndefined();
      expect(childConfig.provider).toBeUndefined();
    });
  });

  describe('named-agent tool access (fail-closed intersection)', () => {
    function mockProvider(): ModelProvider {
      return { name: 'p', query: vi.fn() };
    }

    it('intersects the named agent allowlist with the pre-existing cage (narrows, never widens)', () => {
      // Named agent grants read_file + bash + write_file; the executor already
      // sits in a read-only cage of read_file + grep. Effective = intersection
      // = read_file only. Captured via the provider factory's allowedTools arg.
      let capturedAllowed: string[] | undefined;
      const childProviderFactory = vi.fn((factoryArgs: { allowedTools?: string[] }) => {
        capturedAllowed = factoryArgs.allowedTools;
        return mockProvider();
      });
      buildChildConfig(
        baseArgs({
          depth: 0,
          maxDepth: 3,
          namedAgent: namedAgent({ tools: ['read_file', 'bash', 'write_file'] }),
          allowedTools: ['read_file', 'grep'],
          childProviderFactory,
        }),
      );
      expect(capturedAllowed).toEqual(['read_file']);
    });

    it('uses the named agent allowlist directly when there is no pre-existing cage', () => {
      let capturedAllowed: string[] | undefined;
      const childProviderFactory = vi.fn((factoryArgs: { allowedTools?: string[] }) => {
        capturedAllowed = factoryArgs.allowedTools;
        return mockProvider();
      });
      buildChildConfig(
        baseArgs({
          depth: 0,
          maxDepth: 3,
          namedAgent: namedAgent({ tools: ['read_file', 'grep'] }),
          allowedTools: undefined,
          childProviderFactory,
        }),
      );
      expect(capturedAllowed).toEqual(['read_file', 'grep']);
    });

    it('propagates bash read-only when the named agent declares bash: read-only', () => {
      let capturedReadOnly: boolean | undefined;
      const childProviderFactory = vi.fn((factoryArgs: { readOnlyBash?: boolean }) => {
        capturedReadOnly = factoryArgs.readOnlyBash;
        return mockProvider();
      });
      buildChildConfig(
        baseArgs({
          depth: 0,
          maxDepth: 3,
          namedAgent: namedAgent({ tools: ['bash'] }, { bashReadOnly: true }),
          childProviderFactory,
        }),
      );
      expect(capturedReadOnly).toBe(true);
    });

    it('builds a restricted provider at the depth cap when a cage is present (fail-closed, no fan-out)', () => {
      // At maxDepth with an allowedTools cage but no factory-built nested
      // executor, the else-branch installs buildSkillRestrictedProvider so the
      // fork cannot silently inherit the unrestricted default provider.
      const { childConfig, childManager } = buildChildConfig(
        baseArgs({
          depth: 3,
          maxDepth: 3,
          allowedTools: ['read_file', 'grep'],
          childProviderFactory: vi.fn(),
        }),
      );
      // No nested manager at the cap, but a provider IS set (restricted).
      expect(childManager).toBeUndefined();
      expect(childConfig.provider).toBeDefined();
    });
  });
});
