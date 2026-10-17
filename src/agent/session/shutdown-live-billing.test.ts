/** Integration: a real handle's surviving iterator participates in parent sealing. */
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentConfig, IAgentSession, OutputEvent } from '../types.js';
import { AbortGraph } from '../abort-graph.js';
import { SubagentHandleImpl } from '../subagent/handle.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { SEAL_PENDING_WRITES_TIMEOUT_MS } from '../trace/pending-writes.js';
import { usageToMetadata } from './stream-consumer.js';
import { openAICompatibleBilling } from '../usage.billing.js';
import { AccountingAccumulator } from './accounting-accumulator.js';
import { SessionShutdown } from './session-shutdown.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  const gate = deferred();
  const accounting = new AccountingAccumulator();
  const writer = new InMemoryTraceWriter();
  const session = {
    async *sendMessageStream() {
      await gate.promise;
      yield { type: 'done', metadata: usageToMetadata({ billing: openAICompatibleBilling(100, 60, 5) }, 'late') } as OutputEvent;
    },
    async interrupt() {}, async close() {},
  } as unknown as IAgentSession;
  const controller = new AbortController();
  const graph = new AbortGraph();
  graph.register('child', controller);
  const handle = new SubagentHandleImpl('child', session, controller, graph, undefined, 10,
    undefined, vi.fn(), undefined, undefined, undefined, undefined, undefined, writer,
    (usage, cost) => accounting.recordSubagentCompletion(usage, cost));
  const config = {
    model: 'sonnet', traceWriter: writer,
    getPendingChildBillingStreams: () => handle.pendingBillingStreams,
  } as AgentConfig;
  const shutdown = new SessionShutdown({
    getConfig: () => config, getAbortController: () => new AbortController(),
    getHookRegistry: () => undefined, accounting, ownedTraceWriter: writer, ownsTraceSeal: true,
    getTurnCount: () => 0, getSessionId: () => 'parent',
  });
  return { gate, accounting, writer, handle, shutdown };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('seals late billed done from a real abandoned child after shutdown begins', async () => {
  vi.useFakeTimers();
  const h = setup();
  const failed = h.handle.run('go').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(10);
  expect(await failed).toBeInstanceOf(Error);
  expect(h.handle.pendingBillingStreams).toHaveLength(1);
  const closing = h.shutdown.dispatchOnce('close');
  await vi.advanceTimersByTimeAsync(0);
  expect(h.writer.events.some((event) => event.kind === 'session_sealed')).toBe(false);
  h.gate.resolve();
  await closing;
  const seal = h.writer.events.find((event) => event.kind === 'session_sealed');
  expect(seal?.kind === 'session_sealed' && seal.payload.billing?.subagents?.total)
    .toEqual({ uncachedInput: 40, cacheRead: 60, cacheWrite: 0, output: 5 });
  expect(h.handle.pendingBillingStreams).toHaveLength(0);
});

it('bounds shutdown of a real neverending abandoned child and warns', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = setup();
  const failed = h.handle.run('go').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(10);
  await failed;
  let closed = false;
  const closing = h.shutdown.dispatchOnce('close').then(() => { closed = true; });
  await vi.advanceTimersByTimeAsync(SEAL_PENDING_WRITES_TIMEOUT_MS - 1);
  expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await closing;
  expect(closed).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/billing.*5000ms.*snapshot/i));
  expect(h.writer.events.some((event) => event.kind === 'session_sealed')).toBe(true);
  // End the test-owned iterator after the cutoff; it cannot rewrite the seal.
  h.gate.resolve();
  await Promise.all(h.handle.pendingBillingStreams);
  expect(vi.getTimerCount()).toBe(0);
});
