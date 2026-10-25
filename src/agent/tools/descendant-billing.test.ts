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
import { managerShutdownConfig } from '../session/manager-shutdown-config.js';
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); _resetRegistry(); });

describe('depth-3 abandoned billing stream reaches root session_sealed (#3961)', () => {
  // Real root/nested managers, handles and executors; only the transport is faked.
  // Each hop passes its own session's abort signal. The
  // depth-3 provider stalls before its billed turn.completed and ignores
  // interrupts. In `awaited` mode its own budget abandons the stream while billing
  // is outstanding and the depth-2-owned manager retains it (item 1: it must forward
  // to the ROOT set, not its parent's local set). The late usage lands only
  // after shutdown snapshots the root, which is the only manager shutdown reads.
  it.each(['awaited', 'detached'] as const)('%s: root seal includes a depth-3 abandoned stream', async (mode) => {
    vi.stubEnv('AFK_SUBAGENT_TIMEOUT_MS', mode === 'awaited' ? '150' : '0');
    let snapshot = 0;
    const writer = new InMemoryTraceWriter();
    let wired: ReturnType<typeof wireExecutors> | undefined;
    // detached: the depth-3 provider ignores interrupts, so the depth-2 parent
    // would wait out the full 5 s drain timeout before sealing (#3966). Pass a
    // small timeout so the test completes in <200 ms instead of ~5 s.
    const drainTimeoutMs = mode === 'detached' ? 50 : undefined;
    const hooks = (): ReturnType<typeof managerShutdownConfig> => managerShutdownConfig(wired!.rootManager, undefined, drainTimeoutMs);
    const session = new AgentSession({
      model: 'sonnet', apiKey: 'test-key', provider: createMockProvider(), traceWriter: writer,
      drainSubagents: (reason) => hooks().drainSubagents!(reason),
      getPendingChildTerminalWrites: () => hooks().getPendingChildTerminalWrites!(),
      // Late usage lands only AFTER shutdown snapshots the root: a stream missing
      // from this snapshot is never awaited, so its billing misses the seal.
      getPendingChildBillingStreams: () => { const streams = hooks().getPendingChildBillingStreams!(); snapshot = streams.length; setTimeout(release, 0); return streams; },
    }, writer);
    await session.waitForInitialization();
    const depth = 3;
    let forks = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let stalled!: () => void;
    const deepestStalled = new Promise<void>((resolve) => { stalled = resolve; });
    transport.build = (args) => {
      const index = forks++;
      const deepest = index === depth - 1;
      const base = createMockProvider({ sessionId: `abandoned-${index}` });
      return {
        ...base,
        query(queryArgs) {
          const query = base.query(queryArgs);
          return {
            ...query,
            interrupt: deepest ? async () => {} : query.interrupt.bind(query),
            async *[Symbol.asyncIterator]() {
              for await (const event of query) {
                if (event.type === 'assistant.message' && !deepest) {
                  const child = (args.childExecutor as SubagentExecutor).execute({ id: `abandon-${index + 1}`, name: 'agent',
                    signal: queryArgs.config.abortSignal ?? signal, input: { prompt: 'probe' } });
                  if (mode === 'awaited' || index < depth - 2) await child;
                }
                if (event.type === 'turn.completed' && deepest) {
                  stalled();
                  await gate;
                  event.usage = { ...event.usage, billing: { provider: 'anthropic-direct', uncachedInput: 300, cacheRead: 0, cacheWrite: 0, output: 7 } };
                }
                yield event;
              }
            },
          };
        },
      };
    };
    wired = wireExecutors({
      surface: 'cli', parentSession: session, apiKey: 'test-key', model: 'sonnet', managerParentModel: 'sonnet',
      defaultSubagentModel: 'sonnet', resolveApiKeyForModel: () => 'test-key', pluginConfigs: [],
      traceWriter: writer, skillTraceWriter: writer,
    });
    wired.rootManager.setOnSubagentSucceeded((...args) => session.recordSubagentCompletion(...args));
    const rootCall = wired.subagentExecutor.execute({ id: 'abandon-0', name: 'agent', signal, input: { prompt: 'probe' } });
    await deepestStalled;
    expect(forks).toBe(depth);
    // awaited: past the depth-3 child's 150ms budget, its stream is abandoned and
    // its handle recorded. detached: no budget and its depth-2 parent does not
    // wait, so at seal the depth-3 handle is still ACTIVE in a nested manager.
    if (mode === 'awaited') await new Promise((resolve) => setTimeout(resolve, 250));
    await session.close();
    await rootCall;
    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('missing seal');
    expect(sealed.payload.billing?.subagents?.total.uncachedInput,
      'root session_sealed must include the depth-3 child\'s abandoned-stream billing').toBe(300);
    // detached: the root snapshot itself must hold the still-active depth-3 stream
    // alongside the depth-1 stream (blocked on its tool call), not only reach it transitively.
    if (mode === 'detached') expect(snapshot, 'root snapshot must include the still-active depth-3 stream').toBe(2);
  }, 15000);
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
