import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../types.js';
import { AccountingAccumulator } from '../session/accounting-accumulator.js';
import { SessionShutdown } from '../session/session-shutdown.js';
import { managerShutdownConfig, pendingChildBillingStreams } from '../session/manager-shutdown-config.js';
import type { SubagentManager } from '../subagent.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { openAICompatibleBilling } from '../usage.billing.js';

const { createManager, runDag } = vi.hoisted(() => ({ createManager: vi.fn(), runDag: vi.fn() }));
vi.mock('./compose-executor.manager.js', () => ({ createComposeManager: createManager }));
vi.mock('../dag-subagent.js', () => ({ runSubagentDAG: runDag }));
vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn(async () => {}) }));
vi.mock('./usage-notice.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./usage-notice.js')>(),
  evaluateDispatchUsageForModel: vi.fn(async () => ({ notice: undefined, blocked: false })),
}));
vi.mock('./compose-executor.node-build.js', () => ({
  buildComposeDagNode: vi.fn(async () => ({ id: 'a', prompt: 'go', config: { model: 'sonnet' } })),
}));
import { ComposeExecutor } from './compose-executor.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function executor() {
  return new ComposeExecutor({
    parentSession: { sessionId: 'parent', abortSignal: new AbortController().signal },
    apiKey: 'test-key', systemPrompt: 'test', defaultSubagentModel: 'sonnet',
  });
}

async function execute(compose: ComposeExecutor) {
  const result = await compose.execute({
    id: 'compose-call', name: 'compose', signal: new AbortController().signal,
    input: { nodes: [{ id: 'a', prompt: 'go' }] },
  });
  if (result.isError) throw new Error(result.content);
  return result;
}

function managerWithStream(stream: Promise<void>) {
  let streams = [stream];
  const manager = {
    getPendingChildBillingStreams: () => streams,
    teardownAll: vi.fn(async () => { streams = []; }),
  };
  createManager.mockReturnValueOnce(manager);
  return manager;
}

describe('compose child billing cutoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    runDag.mockResolvedValue({ outputs: {}, failed: [], skipped: [], partial: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('retains old stream receipts across ephemeral manager teardown and subsequent calls', async () => {
    const first = deferred();
    const second = deferred();
    const firstManager = managerWithStream(first.promise);
    const secondManager = managerWithStream(second.promise);
    const compose = executor();
    expect(await execute(compose)).toMatchObject({ isError: false });
    expect(await execute(compose)).toMatchObject({ isError: false });
    expect(firstManager.teardownAll).toHaveBeenCalledOnce();
    expect(secondManager.teardownAll).toHaveBeenCalledOnce();
    expect(compose.getPendingChildBillingStreams()).toEqual([first.promise, second.promise]);
    first.resolve();
    second.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(compose.getPendingChildBillingStreams()).toEqual([]);
  });

  // Both slots go through the production helpers every surface uses, so a
  // surface that forgets compose (round-3 finding) fails here.
  it.each(['surface', 'sdk'] as const)('includes late compose billing in parent shutdown via %s', async (slot) => {
    const gate = deferred();
    const accounting = new AccountingAccumulator();
    const settlement = gate.promise.then(() => {
      accounting.recordSubagentCompletion({ billing: openAICompatibleBilling(100, 60, 5), outcome: 'failed' });
    });
    managerWithStream(settlement);
    const compose = executor();
    expect(await execute(compose)).toMatchObject({ isError: false });
    const writer = new InMemoryTraceWriter();
    const rootManager = {
      abortAllAndDrain: async () => {},
      getPendingChildTerminalWrites: () => [],
      getPendingChildBillingStreams: () => [],
    } as unknown as SubagentManager;
    const config = {
      model: 'sonnet', traceWriter: writer,
      ...(slot === 'surface' ? managerShutdownConfig(rootManager, compose) : {
        executors: {
          bind() {}, drain: async () => {}, composeExecutor: compose,
          getPendingChildBillingStreams: () => pendingChildBillingStreams(rootManager, compose),
        },
      }),
    } as AgentConfig;
    const shutdown = new SessionShutdown({
      getConfig: () => config, getAbortController: () => new AbortController(),
      getHookRegistry: () => undefined, accounting, ownedTraceWriter: writer, ownsTraceSeal: true,
      getTurnCount: () => 0, getSessionId: () => 'parent',
    });
    const closing = shutdown.dispatchOnce('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.events.some((row) => row.kind === 'session_sealed')).toBe(false);
    gate.resolve();
    await closing;
    const sealed = writer.events.find((row) => row.kind === 'session_sealed');
    expect(sealed?.kind === 'session_sealed' && sealed.payload.billing?.subagents?.total.output).toBe(5);
  });
});
