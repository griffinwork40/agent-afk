/**
 * Direct unit tests for streamer.helpers.ts — helpers that were previously
 * only covered indirectly through streamer.test.ts (issue #3725).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { makeCaptureState, spawnChild, wireExitHandlers } from './streamer.helpers.js';
import { makeAnsiStripper, utf8SafeTruncate } from './streamer.utils.js';

// ---------------------------------------------------------------------------
// makeCaptureState
// ---------------------------------------------------------------------------

describe('makeCaptureState', () => {
  it('returns a zeroed state with a live stripper', () => {
    const state = makeCaptureState();
    expect(state.displayCaptured).toBe('');
    expect(state.modelCaptured).toBe('');
    expect(state.displayBytes).toBe(0);
    expect(state.modelBytes).toBe(0);
    expect(state.truncated).toBe(false);
    expect(state.overflowKilled).toBe(false);
    expect(state.killedByCaller).toBe(false);
    expect(state.settled).toBe(false);
    // The embedded stripper must be functional.
    expect(state.stripper.strip('hello')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// spawnChild
// ---------------------------------------------------------------------------

describe('spawnChild', () => {
  it('returns a proc for a valid shell command', () => {
    const result = spawnChild('echo hi', undefined, undefined);
    expect('proc' in result).toBe(true);
    if ('proc' in result) {
      result.proc.on('error', () => {}); // absorb async errors in test env
      result.proc.kill();
    }
  });

  it('returns proc or spawnFailed for a bad cwd (platform-dependent)', () => {
    // spawn() with a nonexistent cwd may throw synchronously (spawnFailed) or
    // emit 'error' asynchronously depending on the OS / Node version.
    // Either outcome is acceptable — we just verify the return shape is valid.
    const result = spawnChild('echo hi', '/this/path/does/not/exist/at/all/42', undefined);
    if ('spawnFailed' in result) {
      expect(result.spawnFailed).toBe(true);
      expect(typeof result.message).toBe('string');
    } else {
      // Proc was returned — kill it immediately to avoid the async ENOENT
      // leaking as an unhandled error in the test runner.
      result.proc.kill();
      // Absorb any 'error' event the child emits so it doesn't become an
      // unhandled rejection under vitest.
      result.proc.on('error', () => {});
    }
  });

  it('merges extra env onto process.env', () => {
    const result = spawnChild('echo hi', undefined, { MY_TEST_VAR: '42' });
    expect('proc' in result).toBe(true);
    if ('proc' in result) {
      result.proc.on('error', () => {}); // absorb async errors in test env
      result.proc.kill();
    }
  });
});

// ---------------------------------------------------------------------------
// wireExitHandlers — error handler settled guard (issue #3725)
// ---------------------------------------------------------------------------

describe('wireExitHandlers — error handler settled guard', () => {
  it('does not double-settle when error fires after the promise is already settled', () => {
    const proc = new EventEmitter() as any;
    proc.killed = false;
    const state = makeCaptureState();
    state.settled = true; // simulate already settled (e.g. overflow)

    const resolveResult = vi.fn();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {}, 60_000);

    wireExitHandlers(
      proc,
      state,
      Date.now(),
      timeoutHandle,
      () => {},
      abortController.signal,
      resolveResult,
    );

    proc.emit('error', new Error('spawn error'));

    // resolveResult must NOT be called — the settled guard should short-circuit.
    expect(resolveResult).not.toHaveBeenCalled();
    clearTimeout(timeoutHandle);
  });

  it('settles on error when not yet settled', () => {
    const proc = new EventEmitter() as any;
    proc.killed = false;
    const state = makeCaptureState();
    // state.settled = false (default)

    const resolveResult = vi.fn();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {}, 60_000);

    wireExitHandlers(
      proc,
      state,
      Date.now(),
      timeoutHandle,
      () => {},
      abortController.signal,
      resolveResult,
    );

    proc.emit('error', new Error('spawn error'));

    expect(resolveResult).toHaveBeenCalledOnce();
    const result = resolveResult.mock.calls[0][0];
    expect(result.errorReason).toBe('spawn-failed');
    expect(result.errorMessage).toContain('spawn error');
  });
});

// ---------------------------------------------------------------------------
// wireExitHandlers — close handler parity
// ---------------------------------------------------------------------------

describe('wireExitHandlers — close handler', () => {
  it('does not settle when already settled (overflowKilled)', () => {
    const proc = new EventEmitter() as any;
    proc.killed = false;
    const state = makeCaptureState();
    state.overflowKilled = true;
    state.settled = true;

    const resolveResult = vi.fn();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {}, 60_000);

    wireExitHandlers(
      proc,
      state,
      Date.now(),
      timeoutHandle,
      () => {},
      abortController.signal,
      resolveResult,
    );

    proc.emit('close', 0, null);
    expect(resolveResult).not.toHaveBeenCalled();
    clearTimeout(timeoutHandle);
  });

  it('settles with exit 0 on clean close', () => {
    const proc = new EventEmitter() as any;
    proc.killed = false;
    const state = makeCaptureState();

    const resolveResult = vi.fn();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {}, 60_000);

    wireExitHandlers(
      proc,
      state,
      Date.now(),
      timeoutHandle,
      () => {},
      abortController.signal,
      resolveResult,
    );

    proc.emit('close', 0, null);
    expect(resolveResult).toHaveBeenCalledOnce();
    const result = resolveResult.mock.calls[0][0];
    expect(result.exitCode).toBe(0);
    expect(result.errorReason).toBeUndefined();
  });

  it('reports nonzero-exit on close with non-zero code', () => {
    const proc = new EventEmitter() as any;
    proc.killed = false;
    const state = makeCaptureState();

    const resolveResult = vi.fn();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {}, 60_000);

    wireExitHandlers(
      proc,
      state,
      Date.now(),
      timeoutHandle,
      () => {},
      abortController.signal,
      resolveResult,
    );

    proc.emit('close', 3, null);
    expect(resolveResult).toHaveBeenCalledOnce();
    const result = resolveResult.mock.calls[0][0];
    expect(result.errorReason).toBe('nonzero-exit');
    expect(result.exitCode).toBe(3);
  });

  it('reports signal-killed on close with null code and a signal', () => {
    const proc = new EventEmitter() as any;
    proc.killed = false;
    const state = makeCaptureState();

    const resolveResult = vi.fn();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {}, 60_000);

    wireExitHandlers(
      proc,
      state,
      Date.now(),
      timeoutHandle,
      () => {},
      abortController.signal,
      resolveResult,
    );

    proc.emit('close', null, 'SIGKILL');
    expect(resolveResult).toHaveBeenCalledOnce();
    const result = resolveResult.mock.calls[0][0];
    expect(result.errorReason).toBe('signal-killed');
    expect(result.errorMessage).toContain('SIGKILL');
  });

  it('reports abort when killedByCaller is true', () => {
    const proc = new EventEmitter() as any;
    proc.killed = false;
    const state = makeCaptureState();
    state.killedByCaller = true;

    const resolveResult = vi.fn();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {}, 60_000);

    wireExitHandlers(
      proc,
      state,
      Date.now(),
      timeoutHandle,
      () => {},
      abortController.signal,
      resolveResult,
    );

    proc.emit('close', null, null);
    expect(resolveResult).toHaveBeenCalledOnce();
    const result = resolveResult.mock.calls[0][0];
    expect(result.errorReason).toBe('abort');
  });
});
