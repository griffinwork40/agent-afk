/**
 * The grep handler must not resolve after killing ripgrep until the child has
 * actually exited (bounded). Before this contract the scan-cap and abort paths
 * resolved synchronously after `proc.kill()`, so on Windows (where termination
 * is asynchronous) a live rg could still hold the searched tree open after the
 * tool returned, surfacing as intermittent EBUSY on rmdir (#703).
 *
 * Uses a fake child (EventEmitter) so the ordering is deterministic on every
 * platform instead of depending on real process-exit timing.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

const spawned = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => true);
      child.exitCode = null;
      child.signalCode = null;
      spawned.children.push(child);
      return child;
    }),
  };
});
vi.mock('@vscode/ripgrep', () => ({ rgPath: '/fake/rg' }));
vi.mock('../../routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn().mockResolvedValue(undefined),
}));

import { createGrepHandler } from './grep.js';
import { awaitChildExit, KILL_EXIT_WAIT_MS } from './_await-child-exit.js';

/** Let pending microtasks and the handler's lazy dynamic import settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

function lastChild(): FakeChild {
  const c = spawned.children.at(-1);
  if (!c) throw new Error('spawn was not called');
  return c as FakeChild;
}

function track<T>(p: Promise<T>): { settled: () => boolean; promise: Promise<T> } {
  let done = false;
  void p.then(() => { done = true; });
  return { settled: () => done, promise: p };
}

describe('grep handler waits for a killed child to exit', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spawned.children.length = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('scan-cap kill: does not resolve until the child emits exit', async () => {
    const handler = createGrepHandler(undefined, { scanCapBytes: 10 });
    const run = track(handler({ pattern: 'x', path: process.cwd() }, new AbortController().signal));
    await flush();
    const child = lastChild();

    child.stdout.emit('data', Buffer.from('x'.repeat(64)));
    await flush();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(run.settled()).toBe(false);

    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    const result = await run.promise;
    expect(result.content).toContain('was terminated');
    expect(result.truncated).toBe(true);
  });

  it('abort kill: does not resolve until the child emits exit', async () => {
    const ctrl = new AbortController();
    const handler = createGrepHandler();
    const run = track(handler({ pattern: 'x', path: process.cwd() }, ctrl.signal));
    await flush();
    const child = lastChild();

    ctrl.abort();
    await flush();
    expect(child.kill).toHaveBeenCalled();
    expect(run.settled()).toBe(false);

    child.emit('exit', null, 'SIGTERM');
    const result = await run.promise;
    expect(result).toEqual({ content: 'Search aborted', isError: true });
  });

  it('normal completion is not delayed by the exit wait', async () => {
    const handler = createGrepHandler();
    const run = track(handler({ pattern: 'x', path: process.cwd() }, new AbortController().signal));
    await flush();
    const child = lastChild();
    child.stdout.emit('data', Buffer.from('a.txt:1:x\n'));
    child.emit('close', 0);
    await flush();
    expect(run.settled()).toBe(true);
    expect((await run.promise).content).toBe('a.txt:1:x');
  });
});

describe('awaitChildExit', () => {
  function fake(): FakeChild {
    const c = new EventEmitter() as FakeChild;
    c.exitCode = null;
    c.signalCode = null;
    return c;
  }

  it('resolves immediately for an already-exited child', async () => {
    const c = fake();
    c.exitCode = 0;
    await expect(awaitChildExit(c as never, 60_000)).resolves.toBeUndefined();
  });

  it('never hangs: resolves after the timeout when exit never fires', async () => {
    vi.useFakeTimers();
    try {
      const c = fake();
      const run = track(awaitChildExit(c as never));
      await vi.advanceTimersByTimeAsync(KILL_EXIT_WAIT_MS - 1);
      expect(run.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(run.settled()).toBe(true);
      expect(c.listenerCount('exit')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
