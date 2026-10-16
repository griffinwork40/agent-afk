/** Regression probes for PR #3889's billing/terminal interleaving. */
import { describe, expect, it, vi } from 'vitest';
import type { IAgentSession, OutputEvent } from '../types.js';
import type { TraceSink } from '../trace/writer.js';
import { AbortGraph } from '../abort-graph.js';
import { AccountingAccumulator } from '../session/accounting-accumulator.js';
import { usageToMetadata } from '../session/stream-consumer.js';
import { openAICompatibleBilling } from '../usage.billing.js';
import { TimeoutError } from '../../utils/errors.js';
import { SubagentHandleImpl } from './handle.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const tokens = { uncachedInput: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 100 };
const billedDone: OutputEvent = {
  type: 'done',
  metadata: usageToMetadata({ billing: openAICompatibleBilling(10_000, 9_000, 100) }, 'late'),
};

function harness(mode: 'own' | 'cascade' | 'explicit') {
  const graph = new AbortGraph();
  const parent = new AbortController();
  const controller = new AbortController();
  graph.register('parent', parent);
  graph.register('child', controller);
  graph.linkChild('parent', 'child');
  const writeStarted = deferred();
  const releaseWrite = deferred();
  const releaseDone = deferred();
  const streamFinished = deferred();
  const writer: TraceSink = {
    getTracePath: () => 'in-memory://delayed',
    async write(event) {
      if (event.kind !== 'subagent_lifecycle') return;
      writeStarted.resolve();
      await releaseWrite.promise;
    },
  };
  const session = {
    async *sendMessageStream() {
      try {
        await releaseDone.promise;
        yield billedDone;
      } finally {
        streamFinished.resolve();
      }
    },
    async interrupt() {},
    async close() {},
    getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
    getLastResponseMetadata: () => null,
  } as unknown as IAgentSession;
  const acc = new AccountingAccumulator();
  const report = vi.fn((usage: Parameters<AccountingAccumulator['recordSubagentCompletion']>[0], cost: number | undefined) =>
    acc.recordSubagentCompletion(usage, cost),
  );
  const handle = new SubagentHandleImpl(
    'child', session, controller, graph, undefined, 10, undefined, vi.fn(),
    undefined, undefined, undefined, undefined, undefined, writer, report,
  );
  // Attach rejection handling immediately: the timeout intentionally beats the stream.
  const result = handle.run('go').then(() => undefined, (err: unknown) => err);
  if (mode === 'cascade') parent.abort(new TimeoutError('ancestor timeout', 1));
  const cancellation = mode === 'explicit' ? handle.cancel() : Promise.resolve();
  return { handle, acc, report, result, cancellation, writeStarted, releaseWrite, releaseDone, streamFinished };
}

describe('billing terminal decision, independent of trace persistence', () => {
  for (const mode of ['own', 'cascade'] as const) {
    it(`${mode}: billed done during an unresolved terminal trace write is reported`, async () => {
      const h = harness(mode);
      try {
        await h.writeStarted.promise;
        expect(h.handle.status).toBe('running'); // Preserve public status timing.
        h.releaseDone.resolve();
        await h.streamFinished.promise;
        expect(h.report).toHaveBeenCalledTimes(1);
        expect(h.report.mock.calls[0]?.[0]?.outcome).toBe(mode === 'own' ? 'failed' : 'cancelled');
        expect(h.acc.snapshot().subagentBilling?.total).toEqual(tokens);
      } finally {
        h.releaseWrite.resolve();
        h.releaseDone.resolve();
        await h.result;
      }
      expect(h.report).toHaveBeenCalledTimes(1);
      expect(h.acc.snapshot().subagentCompletedCount).toBe(0);
    });
  }

  for (const mode of ['own', 'cascade', 'explicit'] as const) {
    it(`${mode}: billed done after run rejects is reported exactly once`, async () => {
      const h = harness(mode);
      await h.writeStarted.promise;
      h.releaseWrite.resolve();
      expect(await h.result).toBeInstanceOf(TimeoutError);
      await h.cancellation;
      // A rejected invocation must not erase the cancelled run's pending bill.
      if (mode === 'explicit') await expect(h.handle.run('again')).rejects.toThrow(/cancelled/);
      h.releaseDone.resolve();
      await h.streamFinished.promise;
      expect(h.report).toHaveBeenCalledTimes(1);
      expect(h.report.mock.calls[0]?.[0]?.outcome).toBe(mode === 'own' ? 'failed' : 'cancelled');
      expect(h.acc.snapshot().subagentBilling?.total).toEqual(tokens);
      expect(h.acc.snapshot().subagentCompletedCount).toBe(0);
    });
  }
});
