/** #3929: real managers/handles/executors; only the model transport is faked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProvider } from '../provider.js';
import type { ChildProviderFactoryArgs } from './nesting.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { SkillExecutor } from './skill-executor.js';

const transport = vi.hoisted(() => ({ build: undefined as unknown as (args: ChildProviderFactoryArgs) => ModelProvider }));
vi.mock('./nesting.js', async (original) => ({
  ...await original<typeof import('./nesting.js')>(),
  createChildProviderFactory: () => (args: ChildProviderFactoryArgs) => transport.build(args),
}));
vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn().mockResolvedValue(undefined) }));

import { wireExecutors } from '../session/wire-executors.js';
import { AgentSession } from '../session.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { registerSkill, _resetRegistry } from '../../skills/skill-registry.js';
import * as promptLoader from '../../skills/_lib/prompt-loader.js';
import { executePluginSkill } from './skill-executor/fork-dispatch.js';
import type { SkillExecutorContext } from './skill-executor/types.js';

type Hop = 'agent' | 'skill' | 'plugin';
const signal = new AbortController().signal;

async function dispatch(hop: Hop, agent: SubagentExecutor, skill: SkillExecutor, index = 0): Promise<void> {
  const call = { id: `probe-call-${index}`, name: hop, signal, input: hop === 'agent' ? { prompt: 'probe' } : { name: `billing-probe-${index}` } };
  const result = hop === 'plugin'
    ? await executePluginSkill({ ctx: (skill as unknown as { ctx: SkillExecutorContext }).ctx, currentCwd: undefined },
      'plugin-probe', 'Probe instructions', '/tmp/billing-plugin', undefined, call)
    : await (hop === 'agent' ? agent : skill).execute(call);
  expect(result.isError, result.content).not.toBe(true);
}

beforeEach(() => {
  _resetRegistry();
  for (let i = 0; i < 3; i++) registerSkill({ name: `billing-probe-${i}`, description: 'Billing regression probe', context: 'fork', handler: vi.fn() });
  vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'Probe instructions' });
});
afterEach(() => { vi.restoreAllMocks(); _resetRegistry(); });

describe('descendant billing reaches root session_sealed exactly once', () => {
  it.each<{ chain: Hop[] }>([
    { chain: ['agent', 'agent'] }, { chain: ['skill', 'agent'] }, { chain: ['agent', 'skill'] },
    { chain: ['skill', 'skill'] }, { chain: ['plugin', 'agent'] }, { chain: ['agent', 'plugin'] },
    { chain: ['agent', 'agent', 'skill'] }, { chain: ['skill', 'agent', 'agent'] }, { chain: ['skill', 'skill', 'skill'] },
  ])('chain $chain', async ({ chain }) => {
    const writer = new InMemoryTraceWriter();
    const session = new AgentSession({ model: 'sonnet', apiKey: 'test-key', provider: createMockProvider(), traceWriter: writer }, writer);
    await session.waitForInitialization();
    let forks = 0;
    transport.build = (args) => {
      const index = forks++;
      const base = createMockProvider({ sessionId: `billed-${index}` });
      return {
        ...base,
        query(queryArgs) {
          const query = base.query(queryArgs);
          return {
            ...query,
            async *[Symbol.asyncIterator]() {
              for await (const event of query) {
                if (event.type === 'assistant.message' && chain[index + 1] !== undefined) {
                  await dispatch(chain[index + 1]!, args.childExecutor as SubagentExecutor, args.childSkillExecutor as SkillExecutor, index + 1);
                }
                if (event.type === 'turn.completed') {
                  const n = (index + 1) * 10;
                  event.usage = { ...event.usage, inputTokens: n, outputTokens: n / 10, totalCostUsd: n / 1000,
                    billing: { provider: 'anthropic-direct', uncachedInput: n, cacheRead: n * 2, cacheWrite: n * 3, output: n / 10 } };
                }
                yield event;
              }
            },
          };
        },
      };
    };
    const wired = wireExecutors({
      surface: 'cli', parentSession: session, apiKey: 'test-key', model: 'sonnet', managerParentModel: 'sonnet',
      defaultSubagentModel: 'sonnet', resolveApiKeyForModel: () => 'test-key', pluginConfigs: [],
      traceWriter: writer, skillTraceWriter: writer,
    });
    const record = vi.fn((...args: Parameters<AgentSession['recordSubagentCompletion']>) => session.recordSubagentCompletion(...args));
    // Deliberately late-bound, as on every production surface.
    wired.rootManager.setOnSubagentSucceeded(() => { throw new Error('stale accounting sink'); });
    // Replacing the root sink after executor construction must affect skill factories too.
    wired.rootManager.setOnSubagentSucceeded(record);
    try {
      await dispatch(chain[0]!, wired.subagentExecutor, wired.skillExecutor);
      expect(forks).toBe(chain.length);
    } finally {
      await wired.rootManager.teardownAll();
      await session.close();
    }
    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('missing seal');
    const sum = chain.length * (chain.length + 1) / 2 * 10;
    expect(sealed.payload.billing?.subagents).toEqual({
      total: { uncachedInput: sum, cacheRead: sum * 2, cacheWrite: sum * 3, output: sum / 10 },
      byProvider: { 'anthropic-direct': { uncachedInput: sum, cacheRead: sum * 2, cacheWrite: sum * 3, output: sum / 10 } },
    });
    expect(sealed.payload.subagentCount).toBe(chain.length);
    expect(sealed.payload.subagentTokens?.input).toBe(sum);
    expect(sealed.payload.subagentCostUsd).toBeCloseTo(sum / 1000);
    expect(record).toHaveBeenCalledTimes(chain.length);
    // Each parent's own bill is independent, not a subtree subtotal.
    expect(record.mock.calls.map(([usage]) => usage?.billing?.uncachedInput).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual(chain.map((_, i) => (i + 1) * 10));
  });
});
