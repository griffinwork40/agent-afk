/** #3929: real managers/handles/executors; only the model transport is faked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProvider } from '../provider.js';
import type { ChildProviderFactoryArgs } from './nesting.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { SkillExecutor } from './skill-executor.js';
import type { IAgentSession } from '../types.js';

const transport = vi.hoisted(() => ({ build: undefined as unknown as (args: ChildProviderFactoryArgs) => ModelProvider }));
vi.mock('./nesting.js', async (original) => ({
  ...await original<typeof import('./nesting.js')>(),
  createChildProviderFactory: () => (args: ChildProviderFactoryArgs) => transport.build(args),
}));
vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn().mockResolvedValue(undefined) }));

import { wireExecutors } from '../session/wire-executors.js';
import { AgentSession } from '../session.js';
import { SubagentManager } from '../subagent.js';
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

describe('depth-2 shutdown-cancel: abandoned billing stream reaches session_sealed (#3961)', () => {
  /**
   * Regression for #3961: a depth-2 child's abandoned billing stream, held in a
   * nested SubagentManager, must surface in rootManager.getPendingChildBillingStreams()
   * so session-shutdown.ts awaits it before writing session_sealed.
   *
   * The defect: each SubagentManager keeps pendingChildBillingStreams in a private Set.
   * Before the fix, only the root manager's Set was visible to shutdown — streams
   * retained by nested (depth-2+) managers were invisible because there was no link
   * between the nested manager's set and the root's set.
   *
   * This test directly injects a fake settlement promise into a nested manager's
   * handle-level stream set (bypassing transport), then asserts that
   * rootManager.getPendingChildBillingStreams() surfaces it. The injection mirrors
   * shutdown-billing-cutoff.test.ts:115 which verified the depth-1 case.
   */
  it('nested manager abandoned stream is visible in rootManager.getPendingChildBillingStreams', () => {
    // Root manager (depth-0): owns the shutdown-visible billing set.
    const rootManager = new SubagentManager();

    // Nested manager (depth-1): wired to root's billing set via parentBillingStreams.
    // BEFORE the fix: SubagentManager ignores parentBillingStreams — root sees nothing.
    // AFTER the fix: nested manager propagates retained streams into this shared set.
    type WithPrivateSets = { pendingChildBillingStreams: Set<Promise<void>> };
    const rootSet = (rootManager as unknown as WithPrivateSets).pendingChildBillingStreams;
    const nestedManager = new SubagentManager({ parentBillingStreams: rootSet });

    // Simulate the abandoned-stream path: a fake handle's pendingBillingStreams
    // holds a settlement promise (same technique as shutdown-billing-cutoff.test.ts:115).
    let settlementResolve!: () => void;
    const settlement = new Promise<void>((res) => { settlementResolve = res; });
    const fakeHandle = { pendingBillingStreams: [settlement] };

    // Calling nestedManager.getPendingChildBillingStreams() triggers retainChildBillingStreams
    // on active handles. To inject without a real fork, call the internal retention path
    // by temporarily planting the fake handle via the nestedManager's getPendingChildBillingStreams,
    // which scans active. Instead, directly call the path that production uses:
    // nestedManager.getPendingChildBillingStreams() after inserting into the nested set.
    // The production path is: retainChildBillingStreams(handle) → pendingChildBillingStreams.add
    // AND parentBillingStreams.add. We test the latter by triggering it directly.
    (nestedManager as unknown as WithPrivateSets).pendingChildBillingStreams.add(settlement);
    // Trigger the nested manager's own getPendingChildBillingStreams — this is what
    // any caller of the nested manager does, and it must propagate into rootSet.
    nestedManager.getPendingChildBillingStreams();

    // Now the root reads its set — it must include the stream propagated from nested.
    const streams = rootManager.getPendingChildBillingStreams();
    settlementResolve();

    // BEFORE the fix: streams = [] (no link from nested to root)
    // AFTER the fix: streams = [settlement] (nested propagated via parentBillingStreams)
    expect(streams.length, 'rootManager must surface depth-2 nested manager abandoned billing stream').toBeGreaterThan(0);
  });
});

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
