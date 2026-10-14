// Invariant: this is a current-behavior reproduction, not a fix. A explicitly
// asserts the defect (an unmatched started row after the parent seals), while
// B asserts that partial work still reaches the parent. In the expired-drain
// variant a gate delays the fire-and-forget cancellation write; without that
// gate the real writer queues cancellation before seal and no row is lost.
// No-drain and expired-drain paths both use gates, not elapsed wall time.

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
  const cancellationEntered = deferred<void>();
  const cancellationSettled = deferred<void>();
  // The cancellation emit is fire-and-forget. Delay its arrival at the real
  // writer until after the bounded drain has expired and the seal has flipped.
  const childSink = drain === 'expired' ? {
    getTracePath: () => writer.getTracePath(),
    async write(event: Parameters<typeof writer.write>[0]) {
      if (event.kind === 'subagent_lifecycle' && event.payload.transition === 'cancelled') {
        cancellationEntered.resolve();
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

  const config: AgentConfig = {
    model: 'sonnet', traceWriter: writer,
    ...(drain === 'expired' ? {
      drainSubagents: async () => {
        const outcome = await abortAllAndDrainImpl(
          new Map([['child', handle]]), graph, 'parent', 'session_end',
          'user_signal', 5_000, false, () => {},
        );
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
    await cancellationEntered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
  }
  await closing;
  // Only now can the non-cooperative child finish: its terminal emit hits the
  // already sealed writer. The callback still receives its partial result.
  releaseStream.resolve();
  const result = await delivered.promise;
  releaseCancellationWrite.resolve();
  if (drain === 'expired') await cancellationSettled.promise;
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
      it('A MISSING TRACE RECORD: started and sealed without a terminal child row', async () => {
        if (drain === 'expired') vi.useFakeTimers();
        const { rows } = await reproduce(drain);
        expect(rows.some((r) => r.kind === 'subagent_lifecycle' &&
          r.payload.subagentId === 'child' && r.payload.transition === 'started')).toBe(true);
        expect(rows.some((r) => r.kind === 'session_sealed')).toBe(true);
        // Current defect: a late terminal write is rejected after seal.
        expect(rows.some((r) => r.kind === 'subagent_lifecycle' &&
          r.payload.subagentId === 'child' && r.payload.transition !== 'started')).toBe(false);
      });

      it('B RESULT DELIVERY: partial work reaches the parent despite the missing trace row', async () => {
        if (drain === 'expired') vi.useFakeTimers();
        const { result, rows } = await reproduce(drain);
        expect(result.partialOutput).toBe('recoverable work');
        expect(result.status).toBe(drain === 'expired' ? 'cancelled' : 'failed');
        expect(rows.at(-1)?.kind).toBe('session_sealed');
      });
    });
  }
});
