/** Run ownership when a timed-out iterator survives a retry. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAgentSession, OutputEvent } from '../types.js';
import { AbortGraph } from '../abort-graph.js';
import { usageToMetadata } from '../session/stream-consumer.js';
import { openAICompatibleBilling } from '../usage.billing.js';
import { SubagentHandleImpl } from './handle.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
const done = (input: number): OutputEvent => ({
  type: 'done', metadata: usageToMetadata({ billing: openAICompatibleBilling(input, 0, 1) }, 'done'),
});

it('rejects a rerun until the previous success lifecycle handoff finishes', async () => {
  const write = gate();
  const entered = gate();
  const session = {
    async *sendMessageStream() {
      yield { type: 'message', message: { role: 'assistant', content: 'ok', timestamp: new Date() } } as OutputEvent;
      yield done(17);
    },
    async interrupt() {}, async close() {},
  } as unknown as IAgentSession;
  const graph = new AbortGraph();
  const controller = new AbortController();
  graph.register('child', controller);
  const handle = new SubagentHandleImpl('child', session, controller, graph, undefined, 0,
    undefined, vi.fn(), undefined, undefined, undefined, undefined, undefined,
    { getTracePath: () => 'memory', async write() { entered.resolve(); await write.promise; } });
  const first = handle.run('first');
  await entered.promise;
  expect(handle.status).toBe('succeeded');
  // Capture BEFORE the overlapping call: an admitted rerun would replace it.
  const ledger = handle._billingContext;
  const second = handle.run('overlap').then(() => undefined, (error: unknown) => error);
  // Observe admission synchronously without awaiting the gated second handoff.
  await Promise.resolve();
  expect(handle._billingContext).toBe(ledger);
  write.resolve();
  await first;
  expect(await second).toBeInstanceOf(Error);
  expect(handle._billingContext).toBe(ledger);
});

afterEach(() => vi.useRealTimers());
describe('billing ownership across overlapping reruns', () => {
  for (const timing of ['during retry', 'after retry'] as const) {
    it(`reports abandoned billing once with the old outcome ${timing}`, async () => {
      vi.useFakeTimers();
      const oldDone = gate();
      const oldFinished = gate();
      const newDone = gate();
      let invocation = 0;
      const session = {
        async *sendMessageStream() {
          if (invocation++ === 0) {
            try { await oldDone.promise; yield done(11); }
            finally { oldFinished.resolve(); }
          } else {
            yield { type: 'message', message: { role: 'assistant', content: 'retry', timestamp: new Date() } } as OutputEvent;
            await newDone.promise;
            yield done(23);
          }
        },
        async interrupt() {}, async close() {},
      } as unknown as IAgentSession;
      const graph = new AbortGraph();
      const controller = new AbortController();
      graph.register('child', controller);
      const report = vi.fn();
      const handle = new SubagentHandleImpl('child', session, controller, graph, undefined, 10,
        undefined, vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, report);
      const failed = handle.run('old').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);
      expect(await failed).toBeInstanceOf(Error);
      const retry = handle.run('retry');
      if (timing === 'during retry') {
        oldDone.resolve(); await oldFinished.promise;
      }
      newDone.resolve();
      await retry;
      if (timing === 'after retry') {
        oldDone.resolve(); await oldFinished.promise;
      }
      expect(report).toHaveBeenCalledTimes(2);
      const usages = report.mock.calls.map((call) => call[0] as { outcome?: string; billing?: { uncachedInput: number } });
      expect(usages.find((usage) => usage.outcome === 'failed')?.billing?.uncachedInput).toBe(11);
      expect(usages.find((usage) => usage.outcome === undefined)?.billing?.uncachedInput).toBe(23);
      expect(handle._currentTrace.usage?.billing?.uncachedInput).toBe(23);
      await handle.cancel();
      expect(report).toHaveBeenCalledTimes(2);
    });
  }
});
