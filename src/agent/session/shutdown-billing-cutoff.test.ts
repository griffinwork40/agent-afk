import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../subagent.js';
import type { AgentConfig, IAgentSession } from '../types.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { SEAL_PENDING_WRITES_TIMEOUT_MS } from '../trace/pending-writes.js';
import { openAICompatibleBilling } from '../usage.billing.js';
import { AccountingAccumulator } from './accounting-accumulator.js';
import { SessionShutdown } from './session-shutdown.js';
import { managerShutdownConfig } from './manager-shutdown-config.js';

vi.mock('../session.js', () => ({
  AgentSession: class {
    sessionId = 'child';
    abortSignal = new AbortController().signal;
    async *sendMessageStream() {
      yield { type: 'message', message: { role: 'assistant', content: 'finished', timestamp: new Date() } };
      yield { type: 'done' };
    }
    async interrupt() {}
    async close() {}
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(
  getStreams: () => readonly Promise<void>[],
  drain = async () => {},
  sdk = false,
) {
  const accounting = new AccountingAccumulator();
  const writer = new InMemoryTraceWriter();
  const config = {
    model: 'sonnet', traceWriter: writer, drainSubagents: drain,
    ...(sdk
      ? { executors: { bind() {}, drain, getPendingChildBillingStreams: getStreams } }
      : { getPendingChildBillingStreams: getStreams }),
  } as AgentConfig;
  const shutdown = new SessionShutdown({
    getConfig: () => config,
    getAbortController: () => new AbortController(),
    getHookRegistry: () => undefined,
    accounting, ownedTraceWriter: writer, ownsTraceSeal: true,
    getTurnCount: () => 0, getSessionId: () => 'parent',
  });
  return { accounting, writer, shutdown };
}

function seal(writer: InMemoryTraceWriter) {
  const event = writer.events.find((row) => row.kind === 'session_sealed');
  if (event?.kind !== 'session_sealed') throw new Error('missing seal');
  return event.payload;
}

const recordLateBilling = (accounting: AccountingAccumulator) => {
  accounting.recordSubagentCompletion({ billing: openAICompatibleBilling(100, 60, 5), outcome: 'failed' });
};

describe('parent accounting snapshot waits for abandoned child billing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('collects after drain and includes delayed settlement in the real sealed accumulator', async () => {
    const gate = deferred();
    const collected = deferred();
    let streams: Promise<void>[] = [];
    const { accounting, writer, shutdown } = setup(() => {
      collected.resolve();
      return streams;
    }, async () => {
      // The catch can abandon a stream while the shutdown drain is running.
      streams = [gate.promise.then(() => recordLateBilling(accounting))];
    });
    const closing = shutdown.dispatchOnce('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.events.some((row) => row.kind === 'session_sealed')).toBe(false);
    await collected.promise;
    gate.resolve();
    await closing;
    expect(seal(writer).billing?.subagents?.total).toEqual({ uncachedInput: 40, cacheRead: 60, cacheWrite: 0, output: 5 });
    expect(seal(writer).subagentCount).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('seals within the existing bound and warns on stderr for a neverending stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { writer, shutdown } = setup(() => [new Promise<void>(() => {})]);
    let closed = false;
    const closing = shutdown.dispatchOnce('close').then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(SEAL_PENDING_WRITES_TIMEOUT_MS - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(closed).toBe(true);
    expect(seal(writer).billing).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/billing.*1.*5000ms.*snapshot/i));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a completed child settlement independently of the active map and completed LRU', async () => {
    const manager = new SubagentManager();
    const child = await manager.forkSubagent({
      agentType: 'billing-test',
      parent: { sessionId: 'parent', abortSignal: new AbortController().signal } as IAgentSession,
      config: { model: 'sonnet', idleTimeoutMs: 0 },
    });
    const gate = deferred();
    const hooks = managerShutdownConfig(manager);
    const { accounting, writer, shutdown } = setup(() => hooks.getPendingChildBillingStreams!());
    const settlement = gate.promise.then(() => recordLateBilling(accounting));
    Object.defineProperty(child, 'pendingBillingStreams', { get: () => [settlement] });
    await child.run('go');
    manager.completed.clear();
    const closing = shutdown.dispatchOnce('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.events.some((row) => row.kind === 'session_sealed')).toBe(false);
    gate.resolve();
    await closing;
    expect(seal(writer).billing?.subagents?.total.output).toBe(5);
    expect(manager.getPendingChildBillingStreams()).toEqual([]);
  });

  it('also waits for SDK executor-owned settlement before snapshot', async () => {
    const gate = deferred();
    const { accounting, writer, shutdown } = setup(
      () => [gate.promise.then(() => recordLateBilling(accounting))], async () => {}, true,
    );
    const closing = shutdown.dispatchOnce('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.events.some((row) => row.kind === 'session_sealed')).toBe(false);
    gate.resolve();
    await closing;
    expect(seal(writer).billing?.subagents?.total.output).toBe(5);
  });

  it('a rejected settlement cannot prevent the parent from sealing', async () => {
    const gate = deferred();
    const { writer, shutdown } = setup(() => [gate.promise.then(() => { throw new Error('provider failed'); })]);
    const closing = shutdown.dispatchOnce('close');
    await vi.advanceTimersByTimeAsync(0);
    gate.resolve();
    await closing;
    expect(seal(writer).status).toBe('succeeded');
    expect(vi.getTimerCount()).toBe(0);
  });
});
