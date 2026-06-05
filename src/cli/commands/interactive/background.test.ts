import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BackgroundTaskManager,
  createBackgroundSink,
  detachStreamToBackground,
  type BackgroundTask,
} from './background.js';
import type { OutputEvent } from '../../../agent/types.js';

describe('BackgroundTaskManager', () => {
  let manager: BackgroundTaskManager;

  beforeEach(() => {
    manager = new BackgroundTaskManager();
  });

  it('registers a task with running status', () => {
    const task = manager.register('diagnose');
    expect(task.id).toBe('bg-1');
    expect(task.label).toBe('diagnose');
    expect(task.status).toBe('running');
    expect(task.stats).toEqual({ tokens: 0, toolUses: 0, durationMs: 0 });
  });

  it('assigns incrementing IDs', () => {
    const t1 = manager.register('a');
    const t2 = manager.register('b');
    expect(t1.id).toBe('bg-1');
    expect(t2.id).toBe('bg-2');
  });

  it('drains all running tasks when iterated and cancelled (REPL exit pattern)', () => {
    // Phase 1.5: runReplLoop's `finally` drains bgManager.running() with
    // .cancel(id) for each remaining task to prevent zombie 'running' entries
    // after REPL teardown. This test guards the invariants that make the
    // drain safe: running() returns only running tasks; cancel() is
    // idempotent; already-terminal tasks are not affected.
    const t1 = manager.register('first');
    const t2 = manager.register('second');
    const t3 = manager.register('third');
    manager.complete(t3.id, 'done', { durationMs: 10 }); // already terminal

    expect(manager.running().map(t => t.id).sort()).toEqual(['bg-1', 'bg-2']);

    // Simulate the runReplLoop finally drain.
    for (const t of manager.running()) {
      manager.cancel(t.id);
    }

    expect(manager.running()).toEqual([]);
    expect(manager.get('bg-1')?.status).toBe('cancelled');
    expect(manager.get('bg-2')?.status).toBe('cancelled');
    expect(manager.get('bg-3')?.status).toBe('succeeded'); // not clobbered
  });

  it('emits update on register', () => {
    const listener = vi.fn();
    manager.on('update', listener);
    const task = manager.register('test');
    expect(listener).toHaveBeenCalledWith(task);
  });

  it('updates stats on a running task', () => {
    const task = manager.register('test');
    manager.updateStats(task.id, { tokens: 1000, toolUses: 5 }, 'testing hypothesis');
    expect(task.stats.tokens).toBe(1000);
    expect(task.stats.toolUses).toBe(5);
    expect(task.progressDescription).toBe('testing hypothesis');
  });

  it('ignores stat updates for non-running tasks', () => {
    const task = manager.register('test');
    manager.complete(task.id, 'done', undefined);
    manager.updateStats(task.id, { tokens: 999 });
    expect(task.stats.tokens).toBe(0);
  });

  it('completes a task', () => {
    const updateListener = vi.fn();
    const completeListener = vi.fn();
    manager.on('update', updateListener);
    manager.on('complete', completeListener);

    const task = manager.register('test');
    updateListener.mockClear();

    manager.complete(task.id, 'result text', { durationMs: 1000 });
    expect(task.status).toBe('succeeded');
    expect(task.resultText).toBe('result text');
    expect(updateListener).toHaveBeenCalledWith(task);
    expect(completeListener).toHaveBeenCalledWith(task);
  });

  it('fails a task', () => {
    const completeListener = vi.fn();
    manager.on('complete', completeListener);

    const task = manager.register('test');
    const error = new Error('boom');
    manager.fail(task.id, error);

    expect(task.status).toBe('failed');
    expect(task.error).toBe(error);
    expect(completeListener).toHaveBeenCalledWith(task);
  });

  it('cancels a task', () => {
    const task = manager.register('test');
    manager.cancel(task.id);
    expect(task.status).toBe('cancelled');
  });

  it('lists running tasks', () => {
    const t1 = manager.register('a');
    const t2 = manager.register('b');
    manager.complete(t1.id, 'done', undefined);
    expect(manager.running()).toEqual([t2]);
  });

  it('lists all tasks', () => {
    manager.register('a');
    manager.register('b');
    expect(manager.all()).toHaveLength(2);
  });

  it('gets a task by ID', () => {
    const task = manager.register('test');
    expect(manager.get(task.id)).toBe(task);
    expect(manager.get('nonexistent')).toBeUndefined();
  });
});

describe('createBackgroundSink', () => {
  it('routes progress events to manager stat updates', () => {
    const manager = new BackgroundTaskManager();
    const task = manager.register('test');
    const sink = createBackgroundSink(task, manager);

    const progressEvent: OutputEvent = {
      type: 'progress',
      progress: {
        taskId: 'task-1',
        description: 'reading files',
        totalTokens: 5000,
        toolUses: 3,
        durationMs: 2000,
      },
    };

    sink(progressEvent, { subagentId: '__main__' });
    expect(task.stats.tokens).toBe(5000);
    expect(task.stats.toolUses).toBe(3);
    expect(task.progressDescription).toBe('reading files');
  });

  it('ignores non-progress events', () => {
    const manager = new BackgroundTaskManager();
    const task = manager.register('test');
    const sink = createBackgroundSink(task, manager);

    const chunkEvent: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'content', content: 'hello' },
    };

    sink(chunkEvent, { subagentId: '__main__' });
    expect(task.stats.tokens).toBe(0);
  });
});

describe('detachStreamToBackground', () => {
  it('consumes stream and completes task', async () => {
    const manager = new BackgroundTaskManager();
    const task = manager.register('test');
    const sink = createBackgroundSink(task, manager);

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'hello ' } },
      { type: 'chunk', chunk: { type: 'content', content: 'world' } },
      { type: 'done', metadata: { durationMs: 1000 } },
    ];

    async function* makeStream(): AsyncIterable<OutputEvent> {
      for (const e of events) yield e;
    }

    const completedPromise = new Promise<BackgroundTask>(resolve => {
      manager.on('complete', resolve);
    });

    detachStreamToBackground(makeStream(), 'partial ', 'user input', task, manager, sink);

    const completed = await completedPromise;
    expect(completed.status).toBe('succeeded');
    expect(completed.resultText).toBe('partial hello world');
  });

  it('fails task on stream error event', async () => {
    const manager = new BackgroundTaskManager();
    const task = manager.register('test');
    const sink = createBackgroundSink(task, manager);

    const events: OutputEvent[] = [
      { type: 'error', error: new Error('stream broke') },
    ];

    async function* makeStream(): AsyncIterable<OutputEvent> {
      for (const e of events) yield e;
    }

    const completedPromise = new Promise<BackgroundTask>(resolve => {
      manager.on('complete', resolve);
    });

    detachStreamToBackground(makeStream(), '', 'user input', task, manager, sink);

    const completed = await completedPromise;
    expect(completed.status).toBe('failed');
    expect(completed.error?.message).toBe('stream broke');
  });

  it('fails task on iterator throw', async () => {
    const manager = new BackgroundTaskManager();
    const task = manager.register('test');
    const sink = createBackgroundSink(task, manager);

    async function* makeStream(): AsyncIterable<OutputEvent> {
      throw new Error('iterator exploded');
    }

    const completedPromise = new Promise<BackgroundTask>(resolve => {
      manager.on('complete', resolve);
    });

    detachStreamToBackground(makeStream(), '', 'user input', task, manager, sink);

    const completed = await completedPromise;
    expect(completed.status).toBe('failed');
    expect(completed.error?.message).toBe('iterator exploded');
  });

  it('calls onTurnComplete on success', async () => {
    const manager = new BackgroundTaskManager();
    const task = manager.register('test');
    const sink = createBackgroundSink(task, manager);
    const onComplete = vi.fn().mockResolvedValue(undefined);

    async function* makeStream(): AsyncIterable<OutputEvent> {
      yield { type: 'done', metadata: { durationMs: 100 } } as OutputEvent;
    }

    const completedPromise = new Promise<BackgroundTask>(resolve => {
      manager.on('complete', resolve);
    });

    detachStreamToBackground(makeStream(), 'text', 'full user input', task, manager, sink, undefined, onComplete);

    await completedPromise;
    expect(onComplete).toHaveBeenCalledWith('full user input', 'text');
  });

  it('cancels task when abortSignal is aborted', async () => {
    const manager = new BackgroundTaskManager();
    const task = manager.register('test');
    const sink = createBackgroundSink(task, manager);
    const ac = new AbortController();
    ac.abort();

    async function* makeStream(): AsyncIterable<OutputEvent> {
      yield { type: 'chunk', chunk: { type: 'content', content: 'partial' } } as OutputEvent;
      yield { type: 'done', metadata: { durationMs: 100 } } as OutputEvent;
    }

    const completedPromise = new Promise<BackgroundTask>(resolve => {
      manager.on('complete', resolve);
    });

    detachStreamToBackground(makeStream(), '', 'user input', task, manager, sink, undefined, undefined, ac.signal);

    const completed = await completedPromise;
    expect(completed.status).toBe('cancelled');
  });

  it('cancels task immediately when abortSignal fires during a stalled stream', async () => {
    // Simulates the bug Phase 1.5 fixes: an SDK round-trip that hangs with no
    // yielded chunks. The for-await loop's per-event poll never gets a chance
    // to observe the abort; only the addEventListener path can transition
    // the task to 'cancelled' before the stream resolves naturally.
    const manager = new BackgroundTaskManager();
    const task = manager.register('test-stall');
    const sink = createBackgroundSink(task, manager);
    const ac = new AbortController();

    let resolveStall: () => void = () => {};
    const stallPromise = new Promise<void>(r => { resolveStall = r; });

    async function* makeStream(): AsyncIterable<OutputEvent> {
      // Block until stallPromise resolves — no chunks yielded in the meantime.
      // The per-event poll inside the for-await body cannot run because the
      // iterator's `next()` is awaiting this promise.
      await stallPromise;
      yield { type: 'done', metadata: { durationMs: 100 } } as OutputEvent;
    }

    const completedPromise = new Promise<BackgroundTask>(resolve => {
      manager.on('complete', resolve);
    });

    detachStreamToBackground(makeStream(), '', 'user input', task, manager, sink, undefined, undefined, ac.signal);

    // Abort while the stream is hung. The listener path must fire even though
    // no for-await iteration has run yet.
    ac.abort();

    const completed = await completedPromise;
    expect(completed.status).toBe('cancelled');

    // Release the stalled stream so the floating promise can settle cleanly.
    resolveStall();
  });

  it('calls recordTurn when stats and doneMeta are provided', async () => {
    const sessionStatsModule = await import('../../slash/session-stats.js');
    const recordTurnSpy = vi.spyOn(sessionStatsModule, 'recordTurn');

    const manager = new BackgroundTaskManager();
    const task = manager.register('test');
    const sink = createBackgroundSink(task, manager);
    const stats = {
      totalTurns: 0, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0,
      sessionStartTime: Date.now(), turnCosts: [], turnTokens: [], turns: [],
      model: 'sonnet' as const, planMode: false,
    };
    const doneMeta = { durationMs: 500 };

    async function* makeStream(): AsyncIterable<OutputEvent> {
      yield { type: 'done', metadata: doneMeta } as OutputEvent;
    }

    const completedPromise = new Promise<BackgroundTask>(resolve => {
      manager.on('complete', resolve);
    });

    detachStreamToBackground(makeStream(), 'response', 'full user input text', task, manager, sink, stats);

    await completedPromise;
    expect(recordTurnSpy).toHaveBeenCalledWith(stats, 'full user input text', 'response', doneMeta, []);
    recordTurnSpy.mockRestore();
  });
});
