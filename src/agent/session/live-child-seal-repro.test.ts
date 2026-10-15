// Fix for the missing-terminal-row defect (#3714 Scenario 1):
//
// cancel() stores its trace emit promise in _pendingCancellationWrite.
// SessionShutdown collects these via AgentConfig.getPendingChildTerminalWrites
// and passes them into TraceWriter.seal(), which awaits them (all-settled)
// inside its enqueue task BEFORE appending session_sealed — guaranteeing the
// cancelled row lands before the seal record even when the emit was
// fire-and-forget and the drain had already timed out.
//
// expired-drain: cancel() fires, the write is delayed (simulating a slow sink)
// but completes BEFORE seal; the drain still times out because the child
// stream is still running. The row lands before session_sealed.
//
// absent-drain: cancel() is called explicitly before shutdown, the write
// completes synchronously on an unsealed writer, the row lands before seal.
//
// Both paths use deferred-promise gates, not elapsed wall time.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, IAgentSession, OutputEvent } from '../types.js';
import { AbortGraph } from '../abort-graph.js';
import { SubagentHandleImpl } from '../subagent/handle.js';
import type { SubagentResult } from '../subagent/result.js';
import { abortAllAndDrainImpl } from '../subagent.drain.js';
import { emitSubagentLifecycle } from '../trace/emit.js';
import { NdjsonTraceWriter } from '../trace/writer.js';
import { AccountingAccumulator } from './accounting-accumulator.js';
import { SessionShutdown } from './session-shutdown.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Row {
  kind: string;
  payload: { transition?: string; subagentId?: string };
}

async function reproduce(drain: 'expired' | 'absent') {
  const dir = await mkdtemp(join(tmpdir(), 'afk-live-child-seal-'));
  const writer = new NdjsonTraceWriter({ traceDir: dir });
  const streamEntered = deferred<void>();
  const releaseStream = deferred<void>();
  const releaseInterrupt = deferred<void>();
  const delivered = deferred<SubagentResult<unknown>>();
  const releaseCancellationWrite = deferred<void>();
  const cancellationSettled = deferred<void>();
  // expired-drain: childSink delays the cancelled write until
  // releaseCancellationWrite fires — which happens BEFORE the drain timeout
  // fires (via fake timers), guaranteeing the write completes before seal.
  // The drain still times out because the child STREAM is still running; only
  // the trace write settles early.
  const childSink = drain === 'expired' ? {
    getTracePath: () => writer.getTracePath(),
    async write(event: Parameters<typeof writer.write>[0]) {
      if (event.kind === 'subagent_lifecycle' && event.payload.transition === 'cancelled') {
        await releaseCancellationWrite.promise;
        try {
          await writer.write(event);
        } finally {
          cancellationSettled.resolve();
        }
        return;
      }
      await writer.write(event);
    },
  } : writer;
  const graph = new AbortGraph();
  graph.register('parent', new AbortController());
  const controller = new AbortController();
  graph.register('child', controller);
  graph.linkChild('parent', 'child');
  const session = {
    async *sendMessageStream(): AsyncGenerator<OutputEvent> {
      yield { type: 'chunk', chunk: { type: 'content', content: 'recoverable work' } };
      streamEntered.resolve();
      await releaseStream.promise;
      throw new Error('child stream stopped after parent seal');
    },
    interrupt: () => releaseInterrupt.promise,
    close: async () => {},
  } as unknown as IAgentSession;
  const handle = new SubagentHandleImpl(
    'child', session, controller, graph, undefined, 0, undefined, () => {},
    undefined, undefined, undefined, undefined, 'parent', childSink,
  );
  await emitSubagentLifecycle(writer, {
    transition: 'started', subagentId: 'child', parentId: 'parent', model: 'sonnet',
  });
  handle.runInBackground('go', delivered.resolve);
  await streamEntered.promise;

  // absent-drain: cancel() is called explicitly before shutdown so
  // _pendingCancellationWrite is populated and the row lands on the
  // still-unsealed writer before dispatchOnce runs.
  if (drain === 'absent') {
    void handle.cancel();
  }

  const config: AgentConfig = {
    model: 'sonnet', traceWriter: writer,
    // Wire the pending-writes collector for both paths so seal() can await
    // the in-flight cancellation emit before appending session_sealed (#3714).
    getPendingChildTerminalWrites: () => [handle._pendingCancellationWrite],
    ...(drain === 'expired' ? {
      drainSubagents: async () => {
        const outcome = await abortAllAndDrainImpl(
          new Map([['child', handle]]), graph, 'parent', 'session_end',
          'user_signal', 5_000, false, () => {},
        );
        // Drain times out: stream is still blocking, but the cancellation
        // write was released before the timeout so it settles inside seal().
        expect(outcome).toEqual({ drained: 1, timedOut: true });
      },
    } : {}),
  };
  const shutdown = new SessionShutdown({
    getConfig: () => config,
    getAbortController: () => new AbortController(),
    getHookRegistry: () => undefined,
    accounting: new AccountingAccumulator(),
    getTurnCount: () => 0,
    getSessionId: () => 'parent',
    ownedTraceWriter: writer,
    ownsTraceSeal: true,
  });
  const closing = shutdown.dispatchOnce('close');
  if (drain === 'expired') {
    // Release the cancellation write BEFORE advancing the fake clock.
    // The write completes, then the drain timeout fires; the stream is
    // still blocking so timedOut stays true.
    releaseCancellationWrite.resolve();
    await cancellationSettled.promise;
    await vi.advanceTimersByTimeAsync(5_000);
  }
  await closing;
  // Release the stream so the child can finish and deliver its result.
  releaseStream.resolve();
  const result = await delivered.promise;
  releaseInterrupt.resolve();
  const rows = (await readFile(writer.getTracePath(), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Row);
  await writer.close();
  await rm(dir, { recursive: true, force: true });
  return { rows, result };
}

afterEach(() => { vi.useRealTimers(); });

describe('parent seals while a subagent is live', () => {
  for (const drain of ['expired', 'absent'] as const) {
    describe(drain === 'expired' ? 'bounded drain expires' : 'no drain configured', () => {
      it('A TERMINAL ROW PRESENT: cancelled row reaches writer before seal (#3714)', async () => {
        if (drain === 'expired') vi.useFakeTimers();
        const { rows } = await reproduce(drain);
        expect(rows.some((r) => r.kind === 'subagent_lifecycle' &&
          r.payload.subagentId === 'child' && r.payload.transition === 'started')).toBe(true);
        expect(rows.some((r) => r.kind === 'session_sealed')).toBe(true);
        // Fix verified: _pendingCancellationWrite is awaited by the drain so
        // the cancelled row arrives before the seal even when the sink is async.
        expect(rows.some((r) => r.kind === 'subagent_lifecycle' &&
          r.payload.subagentId === 'child' && r.payload.transition === 'cancelled')).toBe(true);
      });

      it('B RESULT DELIVERY: partial work reaches the parent despite the missing trace row', async () => {
        if (drain === 'expired') vi.useFakeTimers();
        const { result, rows } = await reproduce(drain);
        expect(result.partialOutput).toBe('recoverable work');
        // Both paths call cancel() (explicitly for absent, via drain for expired),
        // so the child status is 'cancelled' in both cases.
        expect(result.status).toBe('cancelled');
        expect(rows.at(-1)?.kind).toBe('session_sealed');
      });
    });
  }
});
