/**
 * Provider-level gate tests for the "Available agent types" listing (#4220).
 *
 * Two concerns:
 *   1. `grantsToolStrict` — the fail-closed helper that replaced `?? true`.
 *      Tested directly with `grantsTool` undefined, returning false, and
 *      returning true.
 *   2. `setUpQuerySession` — end-to-end from gate decision to prompt content.
 *      Exercises the gate in `setUpQuerySession` (provider-query-setup.ts)
 *      by driving it through a real `AnthropicDirectProvider` instance and
 *      spying on `ctx.grantsTool` — the same approach used in
 *      `provider-query-setup.cwd.test.ts`.  This catches regressions
 *      (e.g. restoring `?? true`) that hard-coded `agentTypeListing: ''`
 *      could not.
 *
 * @module agent/providers/anthropic-direct/agent-type-gate.test
 */

import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../../types/config-types.js';
import type { ProviderQueryContext } from './provider-context.js';
import { AnthropicDirectProvider } from './index.js';
import { setUpQuerySession } from './provider-query-setup.js';
import { grantsToolStrict } from '../shared/tool-grant.js';
import type { SubagentExecutor } from '../../tools/subagent-executor.js';

// ---- constants & helpers ---------------------------------------------------

const LISTING = 'Available agent types:\n- research-agent: A read-only research agent.';

const BASE_CONFIG: AgentConfig = {
  model: 'claude-sonnet-4-5',
  apiKey: 'sk-ant-test-gate',
  depth: 1,
  parentSessionId: 'test-parent',
  cwd: '/test',
};

/** Minimal async-generator prompt required by ProviderQueryArgs. */
function makePrompt() {
  return (async function* () { yield { content: 'probe' }; })();
}

/**
 * Stub SubagentExecutor that advertises the `agent` tool and returns LISTING
 * from describeAgentTypeListing().  Cast via unknown to avoid constructing the
 * full executor dependency graph in tests.
 */
function makeSubagentExecutorStub(): SubagentExecutor {
  return {
    describeAgentTool: () => ({
      name: 'agent',
      description: 'Dispatch an agent',
      input_schema: { type: 'object' as const, properties: {} },
    }),
    describeAgentTypeListing: () => LISTING,
  } as unknown as SubagentExecutor;
}

const providers: AnthropicDirectProvider[] = [];

afterEach(() => {
  for (const p of providers.splice(0)) p.close();
  vi.clearAllMocks();
});

/**
 * Build a provider (optionally with a subagentExecutor so the `agent` tool
 * appears in toolDefs), extract its queryContext, and run setUpQuerySession.
 * Returns ctx so the caller can further spy on grantsTool before the call.
 */
function setup(withAgentTool: boolean): {
  ctx: ProviderQueryContext;
  run: () => ReturnType<typeof setUpQuerySession>;
} {
  const provider = new AnthropicDirectProvider({
    clientFactory: () => ({} as Anthropic),
    ...(withAgentTool ? { subagentExecutor: makeSubagentExecutorStub() } : {}),
  });
  providers.push(provider);
  const ctx = (provider as unknown as { queryContext(): ProviderQueryContext }).queryContext();
  return {
    ctx,
    run: () =>
      setUpQuerySession(
        ctx,
        { prompt: makePrompt(), config: BASE_CONFIG },
        'anthropic-direct',
        'claude-sonnet-4-5',
      ),
  };
}

// ---- grantsToolStrict unit tests -------------------------------------------

describe('grantsToolStrict (#4220)', () => {
  it('returns false when grantsTool is undefined (fail-closed)', () => {
    expect(grantsToolStrict(undefined, 'agent')).toBe(false);
  });

  it('returns false when grantsTool returns false', () => {
    expect(grantsToolStrict(() => false, 'agent')).toBe(false);
  });

  it('returns true only when grantsTool explicitly returns true', () => {
    expect(grantsToolStrict(() => true, 'agent')).toBe(true);
  });

  it('forwards the tool name to the callback', () => {
    const spy = vi.fn(() => true);
    grantsToolStrict(spy, 'agent');
    expect(spy).toHaveBeenCalledWith('agent');
  });
});

// ---- setUpQuerySession integration tests -----------------------------------

describe('anthropic-direct agent-type listing gate (#4220)', () => {
  it('omits listing when agent tool is absent from toolDefs (no subagentExecutor)', () => {
    // Gate short-circuits: toolDefs.some(t => t.name === 'agent') === false
    // → agentTypeListing is '' regardless of grantsTool.
    const { run } = setup(false);
    const { toolSystemAppend } = run();
    expect(toolSystemAppend).not.toContain('Available agent types');
  });

  it('omits listing when agent tool is present but grantsTool returns false (fail-closed)', () => {
    // Gate: agent in toolDefs === true, but grantsTool('agent') === false → ''.
    // This is the regression the old hard-coded agentTypeListing:'' masked:
    // restoring `?? true` would make this test red.
    const { ctx, run } = setup(true);
    vi.spyOn(ctx, 'grantsTool').mockImplementation(() => false);
    const { toolSystemAppend } = run();
    expect(toolSystemAppend).not.toContain('Available agent types');
  });

  it('omits listing when grantsTool is absent (fail-closed: undefined → false)', () => {
    // Gate: ctx.grantsTool?.('agent') === true → false when grantsTool is absent.
    // The old `?? true` fallback would have emitted the listing here.
    const { ctx, run } = setup(true);
    // Suppress the method entirely so ctx.grantsTool?.() resolves to undefined.
    (ctx as Record<string, unknown>)['grantsTool'] = undefined;
    const { toolSystemAppend } = run();
    expect(toolSystemAppend).not.toContain('Available agent types');
  });

  it('includes listing when agent tool is present and grantsTool returns true', () => {
    // Gate: toolDefs has agent AND grantsTool('agent') === true → full listing.
    const { ctx, run } = setup(true);
    vi.spyOn(ctx, 'grantsTool').mockImplementation(() => true);
    const { toolSystemAppend } = run();
    expect(toolSystemAppend).toContain('Available agent types');
    expect(toolSystemAppend).toContain('research-agent');
  });
});
