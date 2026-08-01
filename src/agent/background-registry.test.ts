/**
 * Tests for `BackgroundAgentRegistry`.
 *
 * These tests stub `SubagentHandle` rather than wire a real
 * `SubagentManager` + provider — the registry's contract is with the
 * handle interface, not with the underlying SDK. The stub captures the
 * `onResult` callback so each test can drive the terminal-state
 * transition deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

vi.mock('../utils/debug.js', () => ({ debugLog: vi.fn() }));

// Set up a temp AFK_HOME for disk tests so they don't touch real ~/.afk
const bgTestTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-registry-test-'));
process.env['AFK_HOME'] = bgTestTmpDir;

// Hoisted mock so BackgroundAgentRegistry picks up the mocked appendRoutingDecision.
const appendRoutingDecision = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./routing-telemetry.js', () => ({ appendRoutingDecision }));

import { BackgroundAgentRegistry } from './background-registry.js';
import { InMemoryTraceWriter } from './trace/writer.js';
import type { SubagentHandle, SubagentResult, SubagentStatus } from './subagent.js';
import type { Message } from './types.js';

interface StubHandle extends SubagentHandle {
  /** Captured by `runInBackground` — invoke to trigger terminal-state. */
  __fireTerminal: (result: SubagentResult) => void;
  __cancelCalled: number;
  /** Number of times `teardown()` was invoked (registry natural-completion seam). */
  __teardownCalled: number;
  /** Captured onProgress callback, if any. */
  __onProgress?: (event: import('./types/session-types.js').OutputEvent) => void;
  /** Fire a progress event through the captured onProgress callback. */
  __fireProgress: (event: import('./types/session-types.js').OutputEvent) => void;
}

function createStubHandle(id: string): StubHandle {
  let capturedResult: ((r: SubagentResult) => void) | undefined;
  let capturedProgress: ((event: import('./types/session-types.js').OutputEvent) => void) | undefined;
  const stub: Partial<StubHandle> & Record<string, unknown> = {
    id,
    status: 'idle' as SubagentStatus,
    __cancelCalled: 0,
    __teardownCalled: 0,
    runInBackground(
      _prompt: string,
      onResult?: (r: SubagentResult) => void,
      onProgress?: (event: import('./types/session-types.js').OutputEvent) => void,
    ) {
      capturedResult = onResult;
      capturedProgress = onProgress;
      stub['__onProgress'] = onProgress;
    },
    async cancel() {
      (stub.__cancelCalled as number)++;
      // Real handle would synthesize a cancelled result; the registry
      // installs its own terminal callback via runInBackground, so we fire
      // that here to mimic the cascade.
      capturedResult?.({
        id,
        status: 'cancelled' as SubagentStatus,
      });
    },
    __fireTerminal(result: SubagentResult) {
      capturedResult?.(result);
    },
    __fireProgress(event: import('./types/session-types.js').OutputEvent) {
      capturedProgress?.(event);
    },
    async run() { throw new Error('not implemented'); },
    async runToResult() { throw new Error('not implemented'); },
    // Count invocations so tests can assert the registry's natural-completion
    // path reaches teardown (which is where SubagentStop fires on the real
    // handle). The real `stopDispatched` idempotency guard lives in
    // SubagentHandleImpl, not this stub, so exactly-once hook semantics are
    // asserted end-to-end in hooks-integration.test.ts.
    async teardown() { (stub.__teardownCalled as number)++; },
  };
  return stub as StubHandle;
}

function successResult(id: string, content: string): SubagentResult {
  const message: Message = {
    id: `msg-${id}`,
    type: 'message',
    role: 'assistant',
    content,
    model: 'sonnet',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Message;
  return { id, status: 'succeeded' as SubagentStatus, message };
}

function failureResult(id: string, message: string): SubagentResult {
  return {
    id,
    status: 'failed' as SubagentStatus,
    error: { name: 'TestError', message },
  };
}

describe('BackgroundAgentRegistry', () => {
  let writer: InMemoryTraceWriter;
  let registry: BackgroundAgentRegistry;

  beforeEach(() => {
    writer = new InMemoryTraceWriter();
    registry = new BackgroundAgentRegistry({ traceWriter: writer });
  });

  it('register() returns a snapshot with status=running and a fresh jobId', () => {
    const handle = createStubHandle('sub-1');
    const job = registry.register({ handle, prompt: 'investigate stash {2}', model: 'sonnet' });

    expect(job.status).toBe('running');
    expect(job.jobId).toMatch(/^bg-/);
    expect(job.subagentId).toBe('sub-1');
    expect(job.label).toBe('investigate stash {2}');
    expect(job.model).toBe('sonnet');
    expect(job.result).toBeUndefined();
    expect(job.endedAt).toBeUndefined();
  });

  it('emits a background_agent.started witness event on register()', () => {
    const handle = createStubHandle('sub-1');
    registry.register({ handle, prompt: 'do thing', model: 'sonnet' });

    const started = writer.events.filter((e) => e.kind === 'background_agent');
    expect(started).toHaveLength(1);
    const ev = started[0]!;
    expect(ev.kind).toBe('background_agent');
    if (ev.kind === 'background_agent' && ev.payload.transition === 'started') {
      expect(ev.payload.subagentId).toBe('sub-1');
      expect(ev.payload.label).toBe('do thing');
      expect(ev.payload.model).toBe('sonnet');
    } else {
      throw new Error('expected started transition');
    }
  });

  it('truncates label to 80 chars', () => {
    const long = 'x'.repeat(200);
    const handle = createStubHandle('sub-1');
    const job = registry.register({ handle, prompt: long, model: 'sonnet' });
    expect(job.label).toHaveLength(80);
  });

  it('returns immediately — does NOT block on terminal state', async () => {
    const handle = createStubHandle('sub-1');
    const before = Date.now();
    registry.register({ handle, prompt: 'p', model: 'sonnet' });
    const after = Date.now();
    // <50ms is generous — register() should be microsecond-scale
    expect(after - before).toBeLessThan(50);
    // No terminal state yet
    expect(registry.list()[0]?.status).toBe('running');
  });

  it('join() resolves with the completed result and emits .completed + .joined', async () => {
    const handle = createStubHandle('sub-1');
    const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });

    // Fire terminal completion
    handle.__fireTerminal(successResult('sub-1', 'final answer'));

    const result = await registry.join(job.jobId);
    expect(result.status).toBe('succeeded');

    const bgEvents = writer.events.filter((e) => e.kind === 'background_agent');
    const transitions = bgEvents.map((e) =>
      e.kind === 'background_agent' ? e.payload.transition : null,
    );
    expect(transitions).toEqual(['started', 'completed', 'joined']);
  });

  it('join() on an unknown jobId rejects', async () => {
    await expect(registry.join('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('join() resolves immediately on an already-terminal job', async () => {
    const handle = createStubHandle('sub-1');
    const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });
    handle.__fireTerminal(successResult('sub-1', 'done'));

    // First join — initial settle
    await registry.join(job.jobId);

    // Second join — should resolve from the cached settle
    const second = await registry.join(job.jobId);
    expect(second.status).toBe('succeeded');

    // joined should have fired twice
    const joinedCount = writer.events.filter(
      (e) => e.kind === 'background_agent' && e.payload.transition === 'joined',
    ).length;
    expect(joinedCount).toBe(2);
  });

  it('failed job: join() returns failed result; .failed witness event fires', async () => {
    const handle = createStubHandle('sub-1');
    const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });
    handle.__fireTerminal(failureResult('sub-1', 'boom'));

    const result = await registry.join(job.jobId);
    expect(result.status).toBe('failed');
    expect(registry.get(job.jobId)?.status).toBe('failed');

    const failed = writer.events.find(
      (e) => e.kind === 'background_agent' && e.payload.transition === 'failed',
    );
    expect(failed).toBeDefined();
    if (failed?.kind === 'background_agent' && failed.payload.transition === 'failed') {
      expect(failed.payload.errorClass).toBe('TestError');
      expect(failed.payload.errorMessage).toBe('boom');
    }
  });

  it('cancelJob() calls handle.cancel() and transitions to cancelled', async () => {
    const handle = createStubHandle('sub-1');
    const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });

    const ok = await registry.cancelJob(job.jobId);
    expect(ok).toBe(true);
    expect(handle.__cancelCalled).toBe(1);
    expect(registry.get(job.jobId)?.status).toBe('cancelled');

    const cancelled = writer.events.find(
      (e) => e.kind === 'background_agent' && e.payload.transition === 'cancelled',
    );
    expect(cancelled).toBeDefined();
  });

  it('cancelJob() on a terminal job returns false and does not re-cancel', async () => {
    const handle = createStubHandle('sub-1');
    const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });
    handle.__fireTerminal(successResult('sub-1', 'done'));

    const ok = await registry.cancelJob(job.jobId);
    expect(ok).toBe(false);
    expect(handle.__cancelCalled).toBe(0);
  });

  it('cancelJob() on unknown id returns false', async () => {
    const ok = await registry.cancelJob('nope');
    expect(ok).toBe(false);
  });

  it('cancelAll() cancels every running job; ignores terminal ones', async () => {
    const h1 = createStubHandle('s1');
    const h2 = createStubHandle('s2');
    const h3 = createStubHandle('s3');
    registry.register({ handle: h1, prompt: 'a', model: 'sonnet' });
    registry.register({ handle: h2, prompt: 'b', model: 'sonnet' });
    const j3 = registry.register({ handle: h3, prompt: 'c', model: 'sonnet' });

    // Make j3 already-terminal
    h3.__fireTerminal(successResult('s3', 'done'));

    await registry.cancelAll();
    expect(h1.__cancelCalled).toBe(1);
    expect(h2.__cancelCalled).toBe(1);
    expect(h3.__cancelCalled).toBe(0);
    expect(registry.get(j3.jobId)?.status).toBe('completed');
  });

  // H-1: cancelAll() must emit trace events with source: 'cascade'.
  // Before this fix the source parameter was unreachable because runInBackground's
  // terminal callback always invoked markTerminal with 2 args (no source arg).
  // The fix stores cancelSource per-job before calling handle.cancel().
  it('cancelAll() emits cancelled trace event with source: "cascade" (H-1)', async () => {
    const h1 = createStubHandle('cascade-1');
    registry.register({ handle: h1, prompt: 'work', model: 'sonnet' });

    await registry.cancelAll();

    const cancelledEvent = writer.events.find(
      (e) => e.kind === 'background_agent' && e.payload.transition === 'cancelled',
    );
    expect(cancelledEvent).toBeDefined();
    if (cancelledEvent?.kind === 'background_agent' && cancelledEvent.payload.transition === 'cancelled') {
      expect(cancelledEvent.payload.source).toBe('cascade');
    } else {
      throw new Error('expected cancelled event with cascade source');
    }
  });

  it('cancelJob() emits cancelled trace event with source: "explicit" (H-1 contrast)', async () => {
    const h1 = createStubHandle('explicit-1');
    const job = registry.register({ handle: h1, prompt: 'work', model: 'sonnet' });

    await registry.cancelJob(job.jobId);

    const cancelledEvent = writer.events.find(
      (e) => e.kind === 'background_agent' && e.payload.transition === 'cancelled',
    );
    expect(cancelledEvent).toBeDefined();
    if (cancelledEvent?.kind === 'background_agent' && cancelledEvent.payload.transition === 'cancelled') {
      expect(cancelledEvent.payload.source).toBe('explicit');
    } else {
      throw new Error('expected cancelled event with explicit source');
    }
  });

  // C-2: cancelAll() must not hang session teardown when a provider never
  // settles after abort. The CANCEL_DRAIN_TIMEOUT_MS (5 s) guard should
  // resolve the Promise.race and allow teardown to proceed.
  describe('cancelAll() drain timeout (C-2)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves within the timeout even when a job terminalSettled never fires', async () => {
      vi.useFakeTimers();

      // Build a stub handle whose cancel() never fires the terminal callback —
      // simulating a provider that stalls after abort.
      let captured: ((r: SubagentResult) => void) | undefined;
      const hangingHandle: Partial<StubHandle> & Record<string, unknown> = {
        id: 'hang-1',
        status: 'idle' as SubagentStatus,
        __cancelCalled: 0,
        __teardownCalled: 0,
        runInBackground(_prompt: string, onResult?: (r: SubagentResult) => void) {
          captured = onResult;
          // Intentionally never called: simulates a detached job that ignores abort.
          void captured; // keep reference alive
        },
        async cancel() {
          (hangingHandle.__cancelCalled as number)++;
          // Deliberately does NOT call captured() — the terminal callback
          // never fires, so terminalSettled never resolves.
        },
        async run() { throw new Error('not implemented'); },
        async runToResult() { throw new Error('not implemented'); },
        async teardown() { (hangingHandle.__teardownCalled as number)++; },
        __fireTerminal(_result: SubagentResult) {
          // never used in this test
        },
      };

      registry.register({ handle: hangingHandle as StubHandle, prompt: 'hang', model: 'sonnet' });

      // Start cancelAll — it should eventually resolve after the drain timeout.
      const cancelPromise = registry.cancelAll();

      // Before advancing time: the promise is pending (hanging).
      let resolved = false;
      void cancelPromise.then(() => { resolved = true; });

      // Flush microtasks (handle.cancel() resolves synchronously in our stub).
      await Promise.resolve();
      await Promise.resolve();

      // Still pending because terminalSettled never fired.
      expect(resolved).toBe(false);

      // Advance past CANCEL_DRAIN_TIMEOUT_MS (5 000 ms).
      await vi.advanceTimersByTimeAsync(5100);

      // cancelAll must now have resolved.
      await cancelPromise;
      expect(resolved).toBe(true);

      // Sanity: cancel was issued on the hanging job.
      expect(hangingHandle.__cancelCalled).toBe(1);
    });
  });

  it('list() returns jobs in registration order', () => {
    const h1 = createStubHandle('s1');
    const h2 = createStubHandle('s2');
    const j1 = registry.register({ handle: h1, prompt: 'a', model: 'sonnet' });
    const j2 = registry.register({ handle: h2, prompt: 'b', model: 'sonnet' });
    const ids = registry.list().map((j) => j.jobId);
    expect(ids).toEqual([j1.jobId, j2.jobId]);
  });

  it('no traceWriter: register/cancel/join still work (witness emissions become no-ops)', async () => {
    const silent = new BackgroundAgentRegistry({});
    const handle = createStubHandle('sub-1');
    const job = silent.register({ handle, prompt: 'p', model: 'sonnet' });
    handle.__fireTerminal(successResult('sub-1', 'done'));
    const result = await silent.join(job.jobId);
    expect(result.status).toBe('succeeded');
  });

  // M-3: TTL eviction — terminal jobs must be removed from the registry after
  // TERMINAL_EVICT_TTL_MS (5 minutes). Zero test coverage before this fix.
  describe('TTL eviction (M-3)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('job is evicted from registry after TERMINAL_EVICT_TTL_MS (~5 min)', async () => {
      vi.useFakeTimers();

      const handle = createStubHandle('evict-1');
      const job = registry.register({ handle, prompt: 'evict me', model: 'sonnet' });

      // Fire terminal — schedules the eviction timer.
      handle.__fireTerminal(successResult('evict-1', 'done'));

      // Job is in the registry immediately after settling.
      expect(registry.get(job.jobId)).toBeDefined();

      // Advance past TERMINAL_EVICT_TTL_MS (5 * 60 * 1000 = 300 000 ms).
      await vi.advanceTimersByTimeAsync(301_000);

      // Job must now be evicted.
      expect(registry.get(job.jobId)).toBeUndefined();
    });

    it('job is NOT evicted before TERMINAL_EVICT_TTL_MS elapses', async () => {
      vi.useFakeTimers();

      const handle = createStubHandle('evict-2');
      const job = registry.register({ handle, prompt: 'not yet', model: 'sonnet' });
      handle.__fireTerminal(successResult('evict-2', 'done'));

      // Advance to just before the TTL.
      await vi.advanceTimersByTimeAsync(299_000);

      // Job must still be present.
      expect(registry.get(job.jobId)).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Transcript ring buffer
  // ---------------------------------------------------------------------------
  describe('transcript ring buffer', () => {
    it('appendTranscript accumulates text for a known job', () => {
      const handle = createStubHandle('t1');
      const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });

      registry.appendTranscript(job.jobId, 'hello ');
      registry.appendTranscript(job.jobId, 'world');

      expect(registry.getTranscript(job.jobId)).toBe('hello world');
    });

    it('appendTranscript trims to MAX_TRANSCRIPT_TAIL_BYTES from the front', async () => {
      const { MAX_TRANSCRIPT_TAIL_BYTES } = await import('./background-registry.js');
      const handle = createStubHandle('t2');
      const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });

      // Write more than the limit
      const bigChunk = 'x'.repeat(MAX_TRANSCRIPT_TAIL_BYTES + 100);
      registry.appendTranscript(job.jobId, bigChunk);

      const tail = registry.getTranscript(job.jobId);
      expect(tail).toBeDefined();
      expect(tail!.length).toBe(MAX_TRANSCRIPT_TAIL_BYTES);
      // Should contain the *last* bytes, not the first
      expect(tail).toBe('x'.repeat(MAX_TRANSCRIPT_TAIL_BYTES));
    });

    it('appendTranscript is a silent no-op for unknown jobId', () => {
      // Must not throw
      expect(() => registry.appendTranscript('no-such-job', 'text')).not.toThrow();
    });

    it('getTranscript returns undefined for unknown jobId', () => {
      expect(registry.getTranscript('no-such-job')).toBeUndefined();
    });

    it('getTranscript returns accumulated text for a known job', () => {
      const handle = createStubHandle('t3');
      const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });

      registry.appendTranscript(job.jobId, 'part one ');
      registry.appendTranscript(job.jobId, 'part two');

      expect(registry.getTranscript(job.jobId)).toBe('part one part two');
    });
  });

  describe('event emitter surface', () => {
    it('register() emits exactly one started event with the registered job snapshot', () => {
      const handle = createStubHandle('sub-ee-1');
      const listener = vi.fn();
      registry.on('started', listener);

      const job = registry.register({ handle, prompt: 'start test', model: 'sonnet' });

      expect(listener).toHaveBeenCalledTimes(1);
      const [emittedJob] = listener.mock.calls[0] as [ReturnType<typeof registry.get>];
      expect(emittedJob?.jobId).toBe(job.jobId);
      expect(emittedJob?.status).toBe('running');
    });

    it('completing a job emits exactly one settled event', () => {
      const handle = createStubHandle('sub-ee-2');
      const listener = vi.fn();
      registry.on('settled', listener);

      const job = registry.register({ handle, prompt: 'complete test', model: 'sonnet' });
      handle.__fireTerminal(successResult('sub-ee-2', 'all done'));

      expect(listener).toHaveBeenCalledTimes(1);
      const [emittedJob] = listener.mock.calls[0] as [ReturnType<typeof registry.get>];
      expect(emittedJob?.jobId).toBe(job.jobId);
      expect(emittedJob?.status).toBe('completed');
    });

    it('failing a job emits exactly one settled event', () => {
      const handle = createStubHandle('sub-ee-3');
      const listener = vi.fn();
      registry.on('settled', listener);

      const job = registry.register({ handle, prompt: 'fail test', model: 'sonnet' });
      handle.__fireTerminal(failureResult('sub-ee-3', 'explosion'));

      expect(listener).toHaveBeenCalledTimes(1);
      const [emittedJob] = listener.mock.calls[0] as [ReturnType<typeof registry.get>];
      expect(emittedJob?.jobId).toBe(job.jobId);
      expect(emittedJob?.status).toBe('failed');
    });

    it('cancelJob() emits exactly one settled event', async () => {
      const handle = createStubHandle('sub-ee-4');
      const listener = vi.fn();
      registry.on('settled', listener);

      const job = registry.register({ handle, prompt: 'cancel test', model: 'sonnet' });
      await registry.cancelJob(job.jobId);

      expect(listener).toHaveBeenCalledTimes(1);
      const [emittedJob] = listener.mock.calls[0] as [ReturnType<typeof registry.get>];
      expect(emittedJob?.jobId).toBe(job.jobId);
      expect(emittedJob?.status).toBe('cancelled');
    });

    it('join() resolves and emits exactly one joined event', async () => {
      const handle = createStubHandle('sub-ee-5');
      const listener = vi.fn();
      registry.on('joined', listener);

      const job = registry.register({ handle, prompt: 'join test', model: 'sonnet' });
      handle.__fireTerminal(successResult('sub-ee-5', 'result'));

      await registry.join(job.jobId);

      expect(listener).toHaveBeenCalledTimes(1);
      const [emittedJob] = listener.mock.calls[0] as [ReturnType<typeof registry.get>];
      expect(emittedJob?.jobId).toBe(job.jobId);
    });

    it('started event payload includes the same jobId returned by register()', () => {
      const handle = createStubHandle('sub-ee-6');
      const listener = vi.fn();
      registry.on('started', listener);

      const job = registry.register({ handle, prompt: 'id check', model: 'sonnet' });

      expect(listener).toHaveBeenCalledTimes(1);
      const [emittedJob] = listener.mock.calls[0] as [ReturnType<typeof registry.get>];
      expect(emittedJob?.jobId).toBe(job.jobId);
    });

    it('removed listener is not invoked after removal', () => {
      const h1 = createStubHandle('sub-ee-7a');
      const h2 = createStubHandle('sub-ee-7b');
      const listener = vi.fn();
      registry.on('settled', listener);

      // First job — listener should fire once when terminal fires
      const j1 = registry.register({ handle: h1, prompt: 'first', model: 'sonnet' });
      h1.__fireTerminal(successResult('sub-ee-7a', 'done'));

      expect(registry.get(j1.jobId)?.status).toBe('completed');
      expect(listener).toHaveBeenCalledTimes(1);

      // Remove the listener
      registry.off('settled', listener);

      // Second job — listener must NOT fire
      registry.register({ handle: h2, prompt: 'second', model: 'sonnet' });
      h2.__fireTerminal(successResult('sub-ee-7b', 'done'));

      expect(listener).toHaveBeenCalledTimes(1); // still 1, not 2
    });
  });

  // ---------------------------------------------------------------------------
  // SubagentStop lifecycle seam — a naturally-completing background job must
  // tear its handle down so `SubagentStop` fires, matching the guarantee
  // foreground jobs get from SubagentExecutor's finally block. Regression test
  // for the bug where markTerminal() settled + emitted telemetry but never
  // called handle.teardown(), so background SubagentStop handlers never ran.
  //
  // These assert the WIRING (teardown is reached on natural completion). The
  // exactly-once hook semantics — which depend on SubagentHandleImpl's
  // `stopDispatched` guard, not on this stub — are proven end-to-end in
  // hooks-integration.test.ts.
  // ---------------------------------------------------------------------------
  describe('SubagentStop teardown seam', () => {
    it('natural completion (succeeded) tears the handle down exactly once', async () => {
      const handle = createStubHandle('stop-1');
      const job = registry.register({ handle, prompt: 'work', model: 'sonnet' });

      expect(handle.__teardownCalled).toBe(0); // not yet — still running

      handle.__fireTerminal(successResult('stop-1', 'answer'));

      // Terminal state is observable synchronously (settle + emit happen before
      // the trailing `await handle.teardown()`), so join resolves immediately.
      const result = await registry.join(job.jobId);
      expect(result.status).toBe('succeeded');

      // The async teardown resolves on a later microtask; flush before asserting.
      await Promise.resolve();
      expect(handle.__teardownCalled).toBe(1);
    });

    it('natural completion (failed) also tears the handle down', async () => {
      const handle = createStubHandle('stop-2');
      const job = registry.register({ handle, prompt: 'work', model: 'sonnet' });

      handle.__fireTerminal(failureResult('stop-2', 'boom'));

      const result = await registry.join(job.jobId);
      expect(result.status).toBe('failed');

      await Promise.resolve();
      expect(handle.__teardownCalled).toBe(1);
    });

    it('teardown runs AFTER settle + witness emit (synchronous observability preserved)', () => {
      // Firing terminal synchronously must leave the job observable as
      // terminal *before* the async teardown suspends — the ordering invariant
      // that keeps every synchronous assertion in this file valid.
      const handle = createStubHandle('stop-3');
      const settled: string[] = [];
      registry.on('settled', (j) => settled.push(j.status));

      const job = registry.register({ handle, prompt: 'work', model: 'sonnet' });
      handle.__fireTerminal(successResult('stop-3', 'answer'));

      // No await yet: settle + emit already ran synchronously inside __fireTerminal.
      expect(settled).toEqual(['completed']);
      expect(registry.get(job.jobId)?.status).toBe('completed');
    });

    it('complete-then-cancel: teardown reached on completion; later cancelJob is a no-op', async () => {
      const handle = createStubHandle('stop-4');
      const job = registry.register({ handle, prompt: 'work', model: 'sonnet' });

      // Natural completion first — reaches teardown (fires SubagentStop on a
      // real handle) and settles the job.
      handle.__fireTerminal(successResult('stop-4', 'answer'));
      await registry.join(job.jobId);
      await Promise.resolve();
      expect(handle.__teardownCalled).toBe(1);
      expect(registry.get(job.jobId)?.status).toBe('completed');

      // A subsequent cancelJob on the already-terminal job returns false and
      // does NOT re-cancel or re-tear-down: the registry short-circuits on
      // non-running status, so SubagentStop cannot double-fire.
      const cancelled = await registry.cancelJob(job.jobId);
      expect(cancelled).toBe(false);
      expect(handle.__cancelCalled).toBe(0);
      expect(handle.__teardownCalled).toBe(1); // still exactly one
    });

    it('cancelJob before completion: markTerminal short-circuits, no double teardown', async () => {
      // On the cancel path the real handle fires SubagentStop from cancel()
      // itself (setting stopDispatched) before the synthesized cancelled result
      // re-enters markTerminal — so the trailing teardown there is a guaranteed
      // no-op. The stub can't model the shared guard, but it CAN prove the
      // registry never invokes teardown twice for one job.
      const handle = createStubHandle('stop-5');
      const job = registry.register({ handle, prompt: 'work', model: 'sonnet' });

      await registry.cancelJob(job.jobId);
      await Promise.resolve();

      expect(handle.__cancelCalled).toBe(1);
      expect(registry.get(job.jobId)?.status).toBe('cancelled');
      // markTerminal ran once (via the cancelled result the stub's cancel()
      // fires), so the registry called teardown at most once for this job.
      expect(handle.__teardownCalled).toBeLessThanOrEqual(1);
    });

    it('promotion path (adoptRunning): natural completion tears the handle down', async () => {
      // adoptRunning attaches to an already-in-flight runPromise instead of
      // calling runInBackground. The terminal callback still routes through
      // markTerminal, so promoted jobs get the same SubagentStop guarantee.
      const handle = createStubHandle('stop-promote');
      let resolveRun!: (r: SubagentResult) => void;
      const runPromise = new Promise<SubagentResult>((res) => {
        resolveRun = res;
      });

      const job = registry.adoptRunning({
        handle,
        runPromise,
        prompt: 'promoted work',
        model: 'sonnet',
      });
      expect(registry.get(job.jobId)?.status).toBe('running');
      expect(handle.__teardownCalled).toBe(0);

      // Resolve the in-flight run — drives markTerminal via the `.then`.
      resolveRun(successResult('stop-promote', 'promoted answer'));

      const result = await registry.join(job.jobId);
      expect(result.status).toBe('succeeded');

      // Flush the adoptRunning .then → markTerminal → await teardown chain.
      await Promise.resolve();
      await Promise.resolve();
      expect(handle.__teardownCalled).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Persistent log tests (disk I/O via BgJobLogWriter)
  // ---------------------------------------------------------------------------

  describe('persistent log via BgJobLogWriter', () => {
    it('persists label/hash from the plain prompt and never image base64', async () => {
      const prompt = 'inspect the attached image';
      const base64Sentinel = Buffer.from('secret-image-bytes').toString('base64');
      const handle = createStubHandle('sub-disk-hygiene');
      const job = registry.register({ handle, prompt, model: 'sonnet' });

      await new Promise((r) => setTimeout(r, 100));
      const metaPath = path.join(bgTestTmpDir, 'state', 'bg', job.jobId, 'meta.json');
      const rawMeta = fs.readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(rawMeta) as { label: string; promptHash: string };
      expect(meta.label).toBe(prompt);
      expect(meta.promptHash).toBe(createHash('sha256').update(prompt).digest('hex'));
      expect(rawMeta).not.toContain(base64Sentinel);
    });

    it('register() writes meta.json to disk with status=running', async () => {
      const handle = createStubHandle('sub-disk-1');
      const job = registry.register({ handle, prompt: 'disk job', model: 'haiku' });

      // Allow the async writeMeta to settle
      await new Promise((r) => setTimeout(r, 100));

      const { BgJobLogReader } = await import('./bg-job-log.js');
      const meta = await BgJobLogReader.readMeta(job.jobId);
      expect(meta).not.toBeNull();
      expect(meta!.status).toBe('running');
      expect(meta!.jobId).toBe(job.jobId);
      expect(meta!.model).toBe('haiku');
    });

    it('progress events flow to the disk writer', async () => {
      const handle = createStubHandle('sub-disk-2');
      const job = registry.register({ handle, prompt: 'event job', model: 'sonnet' });

      // Fire a progress event
      handle.__fireProgress({
        type: 'chunk',
        chunk: { type: 'content', content: 'hello' } as any,
      });

      // Allow stream to flush
      await new Promise((r) => setTimeout(r, 150));

      const { BgJobLogReader } = await import('./bg-job-log.js');

      // We can't easily read mid-stream (writer is still open), but we can
      // verify the log file exists after firing terminal + close.
      handle.__fireTerminal(successResult('sub-disk-2', 'done'));
      await new Promise((r) => setTimeout(r, 200));

      const events = [];
      for await (const e of BgJobLogReader.readEvents(job.jobId)) {
        events.push(e);
      }
      // Should have at least the content event
      expect(events.some((e) => e.type === 'chunk')).toBe(true);
    });

    it('text events feed appendTranscript()', () => {
      const handle = createStubHandle('sub-disk-3');
      const job = registry.register({ handle, prompt: 'transcript job', model: 'sonnet' });

      // Fire a content chunk via onProgress
      handle.__fireProgress({
        type: 'chunk',
        chunk: { type: 'content', content: 'transcript text' } as any,
      });

      // Check the transcript tail was updated
      const tail = registry.getTranscript(job.jobId);
      expect(tail).toContain('transcript text');
    });

    it('terminal callback updates meta with endedAt + final status', async () => {
      const handle = createStubHandle('sub-disk-4');
      const job = registry.register({ handle, prompt: 'terminal job', model: 'sonnet' });

      handle.__fireTerminal(successResult('sub-disk-4', 'completed output'));

      // Allow the async writeMeta to settle
      await new Promise((r) => setTimeout(r, 200));

      const { BgJobLogReader } = await import('./bg-job-log.js');
      const meta = await BgJobLogReader.readMeta(job.jobId);
      expect(meta).not.toBeNull();
      expect(meta!.status).toBe('completed');
      expect(meta!.endedAt).toBeDefined();
      expect(meta!.endedAt).toBeGreaterThan(0);
    });

    // PR#713 Wave-A A1(b): markTerminal persists `result.stopReason` into the
    // closing meta record so the /bgsub:join disk-fallback path (bgsub.ts) can
    // reconstruct the same partial-result labeling the in-memory replay
    // applies, even after the job's in-memory entry is TTL-evicted.
    it('terminal callback persists stopReason into meta.json when the result carries one', async () => {
      const handle = createStubHandle('sub-disk-5');
      const job = registry.register({ handle, prompt: 'capped job', model: 'sonnet' });

      handle.__fireTerminal({
        ...successResult('sub-disk-5', 'partial output'),
        stopReason: 'tool_use_loop_capped',
      });

      await new Promise((r) => setTimeout(r, 200));

      const { BgJobLogReader } = await import('./bg-job-log.js');
      const meta = await BgJobLogReader.readMeta(job.jobId);
      expect(meta).not.toBeNull();
      expect(meta!.stopReason).toBe('tool_use_loop_capped');
    });

    it('terminal callback leaves meta.stopReason ABSENT when the result carries none', async () => {
      const handle = createStubHandle('sub-disk-6');
      const job = registry.register({ handle, prompt: 'clean job', model: 'sonnet' });

      // successResult() never sets stopReason.
      handle.__fireTerminal(successResult('sub-disk-6', 'clean output'));

      await new Promise((r) => setTimeout(r, 200));

      const { BgJobLogReader } = await import('./bg-job-log.js');
      const meta = await BgJobLogReader.readMeta(job.jobId);
      expect(meta).not.toBeNull();
      expect(meta!.stopReason).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Routing-telemetry surface (A1: bgsub-completion-telemetry)
  //
  // These tests assert that markTerminal() calls appendRoutingDecision with
  // the correct event name for each terminal-state transition.
  // -------------------------------------------------------------------------
  describe('routing-telemetry events (A1)', () => {
    beforeEach(() => {
      appendRoutingDecision.mockClear();
    });

    it('success: emits subagent.completed with correct fields', () => {
      const handle = createStubHandle('rt-succ-1');
      const job = registry.register({
        handle,
        prompt: 'search for bugs',
        model: 'sonnet',
        parentSessionId: 'parent-sess-123',
      });

      handle.__fireTerminal(successResult('rt-succ-1', 'bugs found'));

      const completedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.completed',
      );
      expect(completedCalls).toHaveLength(1);
      const entry = completedCalls[0]![0] as Record<string, unknown>;
      expect(entry['event']).toBe('subagent.completed');
      expect(entry['subagent_id']).toBe(job.subagentId);
      expect(entry['parent_session_id']).toBe('parent-sess-123');
      expect(entry['status']).toBe('succeeded');
      expect(typeof entry['duration_ms']).toBe('number');
      expect(typeof entry['content_chars']).toBe('number');
    });

    it('success: does NOT emit subagent.failed on the happy path', () => {
      const handle = createStubHandle('rt-succ-2');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      handle.__fireTerminal(successResult('rt-succ-2', 'done'));

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(0);
    });

    it('failure: emits subagent.failed with correct fields', () => {
      const handle = createStubHandle('rt-fail-1');
      const job = registry.register({
        handle,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: 'parent-sess-456',
      });

      handle.__fireTerminal(failureResult('rt-fail-1', 'something exploded'));

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(1);
      const entry = failedCalls[0]![0] as Record<string, unknown>;
      expect(entry['event']).toBe('subagent.failed');
      expect(entry['subagent_id']).toBe(job.subagentId);
      expect(entry['parent_session_id']).toBe('parent-sess-456');
      expect(entry['status']).toBe('failed');
      expect(typeof entry['duration_ms']).toBe('number');
    });

    it('cancellation: emits subagent.failed (cancelled treated as non-success)', async () => {
      const handle = createStubHandle('rt-cancel-1');
      const job = registry.register({
        handle,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: 'parent-sess-789',
      });

      await registry.cancelJob(job.jobId);

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(1);
      const entry = failedCalls[0]![0] as Record<string, unknown>;
      expect(entry['event']).toBe('subagent.failed');
      expect(entry['subagent_id']).toBe(job.subagentId);
      expect(entry['parent_session_id']).toBe('parent-sess-789');
    });

    it('parentSessionId is optional — omitting it works without errors', () => {
      const handle = createStubHandle('rt-noparent-1');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      handle.__fireTerminal(successResult('rt-noparent-1', 'done'));

      const completedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.completed',
      );
      expect(completedCalls).toHaveLength(1);
      // parent_session_id omitted → should be undefined (not present or undefined is fine)
      const entry = completedCalls[0]![0] as Record<string, unknown>;
      expect(entry['parent_session_id']).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // stop_reason coverage (subagent partial-result observability).
    //
    // Telemetry proved `stop_reason` appeared on 0 of 14,152 `subagent.completed`
    // rows — this predicate closes that blind spot for the background-registry
    // emit path. `content_chars` must stay computed on the raw, un-annotated
    // content regardless of stopReason (markTerminal never annotates; see the
    // class-level note on markTerminal).
    // -----------------------------------------------------------------------
    it('completed: stop_reason is present and equals the result stopReason when set', () => {
      const handle = createStubHandle('rt-stopreason-1');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      handle.__fireTerminal({
        ...successResult('rt-stopreason-1', 'partial output'),
        stopReason: 'tool_use_loop_capped',
      });

      const completedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.completed',
      );
      expect(completedCalls).toHaveLength(1);
      const entry = completedCalls[0]![0] as Record<string, unknown>;
      expect(entry['stop_reason']).toBe('tool_use_loop_capped');
    });

    it('completed: stop_reason is ABSENT (not null/empty) when the result carries none', () => {
      const handle = createStubHandle('rt-stopreason-2');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      // successResult() never sets stopReason.
      handle.__fireTerminal(successResult('rt-stopreason-2', 'clean answer'));

      const completedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.completed',
      );
      expect(completedCalls).toHaveLength(1);
      const entry = completedCalls[0]![0] as Record<string, unknown>;
      // Key-absence in the PERSISTED row is asserted against the real
      // buildRoutingDecisionRow in routing-telemetry.test.ts. Here
      // appendRoutingDecision is mocked, so the pre-strip entry still carries
      // the key with an undefined value — matching the parent_session_id
      // precedent above ("not present or undefined is fine").
      expect(entry['stop_reason']).toBeUndefined();
    });

    it('completed: content_chars measures raw content, unaffected by a partial stopReason', () => {
      const handle = createStubHandle('rt-stopreason-3');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      const rawContent = 'short partial body';
      handle.__fireTerminal({
        ...successResult('rt-stopreason-3', rawContent),
        stopReason: 'stream_incomplete',
      });

      const completedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.completed',
      );
      const entry = completedCalls[0]![0] as Record<string, unknown>;
      // No `[⚠ PARTIAL RESULT…]` banner counted — markTerminal never annotates.
      expect(entry['content_chars']).toBe(rawContent.length);
      expect(entry['stop_reason']).toBe('stream_incomplete');
    });

    it('failure: stop_reason is present when the failed result carries one', () => {
      const handle = createStubHandle('rt-stopreason-4');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      handle.__fireTerminal({
        ...failureResult('rt-stopreason-4', 'stream died'),
        stopReason: 'stream_incomplete',
      });

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(1);
      const entry = failedCalls[0]![0] as Record<string, unknown>;
      expect(entry['stop_reason']).toBe('stream_incomplete');
    });

    it('failure: stop_reason is absent when the failed result carries none', () => {
      const handle = createStubHandle('rt-stopreason-5');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      handle.__fireTerminal(failureResult('rt-stopreason-5', 'plain failure'));

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(1);
      const entry = failedCalls[0]![0] as Record<string, unknown>;
      // Key-absence in the PERSISTED row is asserted against the real
      // buildRoutingDecisionRow in routing-telemetry.test.ts. Here
      // appendRoutingDecision is mocked, so the pre-strip entry still carries
      // the key with an undefined value — matching the parent_session_id
      // precedent above ("not present or undefined is fine").
      expect(entry['stop_reason']).toBeUndefined();
    });

    it('cancellation: stop_reason is omitted for a bare cancelled result (stub sets none)', async () => {
      const handle = createStubHandle('rt-stopreason-6');
      const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });

      await registry.cancelJob(job.jobId);

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(1);
      const entry = failedCalls[0]![0] as Record<string, unknown>;
      // Key-absence in the PERSISTED row is asserted against the real
      // buildRoutingDecisionRow in routing-telemetry.test.ts. Here
      // appendRoutingDecision is mocked, so the pre-strip entry still carries
      // the key with an undefined value — matching the parent_session_id
      // precedent above ("not present or undefined is fine").
      expect(entry['stop_reason']).toBeUndefined();
    });

    it('cancellation: stop_reason is present when the terminal result carries one', () => {
      // Drives the 'cancelled' branch directly (rather than via cancelJob())
      // so a stopReason can ride the terminal result, mirroring how a
      // cascade-abort might still preserve a stream-incomplete stopReason.
      const handle = createStubHandle('rt-stopreason-7');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      handle.__fireTerminal({
        id: 'rt-stopreason-7',
        status: 'cancelled' as SubagentStatus,
        stopReason: 'stream_incomplete',
      });

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(1);
      const entry = failedCalls[0]![0] as Record<string, unknown>;
      expect(entry['stop_reason']).toBe('stream_incomplete');
    });

    // -------------------------------------------------------------------
    // A3: stop_reason is bounded before it rides into telemetry. On the
    // OpenAI-compatible path `stopReason` is provider-controlled free text
    // (translate.ts / responses-translate.ts), not a bounded enum, so — like
    // the sibling free-form fields — it must be capped, not emitted uncapped.
    // -------------------------------------------------------------------
    it('completed: a >64-char stop_reason is truncated to 64 chars + ellipsis in the emitted row', () => {
      const longReason = 'x'.repeat(100);
      const handle = createStubHandle('rt-stopreason-trunc-1');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      handle.__fireTerminal({
        ...successResult('rt-stopreason-trunc-1', 'done'),
        stopReason: longReason,
      });

      const completedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.completed',
      );
      expect(completedCalls).toHaveLength(1);
      const entry = completedCalls[0]![0] as Record<string, unknown>;
      // truncate(s, 64): first 64 chars + a single '…' — never the raw
      // 100-char string, and never silently dropped.
      expect(entry['stop_reason']).toBe('x'.repeat(64) + '…');
      expect((entry['stop_reason'] as string).length).toBe(65);
    });

    it('failure: a >64-char stop_reason is truncated to 64 chars + ellipsis in the emitted row', () => {
      const longReason = 'y'.repeat(90);
      const handle = createStubHandle('rt-stopreason-trunc-2');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      handle.__fireTerminal({
        ...failureResult('rt-stopreason-trunc-2', 'boom'),
        stopReason: longReason,
      });

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(1);
      const entry = failedCalls[0]![0] as Record<string, unknown>;
      expect(entry['stop_reason']).toBe('y'.repeat(64) + '…');
    });

    it('completed: a stop_reason at or under 64 chars is passed through unchanged (no ellipsis)', () => {
      const shortReason = 'tool_use_loop_capped'; // well under 64 chars
      const handle = createStubHandle('rt-stopreason-trunc-3');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      handle.__fireTerminal({
        ...successResult('rt-stopreason-trunc-3', 'done'),
        stopReason: shortReason,
      });

      const completedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.completed',
      );
      const entry = completedCalls[0]![0] as Record<string, unknown>;
      expect(entry['stop_reason']).toBe(shortReason);
    });

    it('completed: an absent stop_reason stays ABSENT (never truncated to a defined value)', () => {
      const handle = createStubHandle('rt-stopreason-trunc-4');
      registry.register({ handle, prompt: 'p', model: 'sonnet' });
      // successResult() never sets stopReason.
      handle.__fireTerminal(successResult('rt-stopreason-trunc-4', 'done'));

      const completedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.completed',
      );
      const entry = completedCalls[0]![0] as Record<string, unknown>;
      expect(entry['stop_reason']).toBeUndefined();
    });
  });
});
