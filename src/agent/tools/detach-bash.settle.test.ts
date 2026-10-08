/**
 * Regression test for issue #2742: settle-after-kill fallback.
 *
 * On Windows, `taskkill /F /T` may leave MSYS2 (Git Bash) grandchildren alive.
 * Those orphans hold the inherited stdout/stderr pipe, so Node never emits
 * `close`. This file verifies that `execOnDetach`'s bounded fallback timer
 * fires `token.deliver()` even when `proc.once('close')` never calls back.
 *
 * Design notes:
 *   - No platform gating (R4 rule: never skip on win32).
 *   - Uses a mock ChildProcess that never fires `close`, which is a direct
 *     simulation of the Windows MSYS2 orphan scenario.
 *   - The timeout in the race is set to SETTLE_AFTER_KILL_MS + 2000 ms so
 *     the test fails fast if the fallback doesn't fire rather than hanging.
 *
 * @module agent/tools/detach-bash.settle.test
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetachableToolRegistry, type DetachedToolResult } from './detach-registry.js';
import { execOnDetach, SETTLE_AFTER_KILL_MS, BASH_SETTLE_TIMEOUT_SENTINEL, buildBashDelivery } from './detach-bash.js';
import type { OnDetachParams } from './detach-bash.js';
import type { DetachToken } from './detach-registry.js';

/**
 * Minimal ChildProcess stub that never fires 'close'.
 * Simulates a process whose stdio pipe is held open by a surviving grandchild
 * after the parent has been killed — the Windows MSYS2 scenario from #2742.
 */
function makeStubbornProc(): {
  proc: OnDetachParams['proc'];
  stdoutDestroyed: () => boolean;
  stderrDestroyed: () => boolean;
} {
  let stdoutDestroyed = false;
  let stderrDestroyed = false;

  const makeStream = (trackDestroy: () => void) => {
    const s = new EventEmitter() as NodeJS.ReadableStream & { destroy(): void };
    s.destroy = () => { trackDestroy(); };
    return s;
  };

  const proc = new EventEmitter() as unknown as OnDetachParams['proc'];
  (proc as { stdout: unknown }).stdout = makeStream(() => { stdoutDestroyed = true; });
  (proc as { stderr: unknown }).stderr = makeStream(() => { stderrDestroyed = true; });

  return {
    proc,
    stdoutDestroyed: () => stdoutDestroyed,
    stderrDestroyed: () => stderrDestroyed,
  };
}

describe('settle-after-kill fallback (Fix #2742)', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('classifies the settle timeout sentinel as failed even with exit code zero', () => {
    expect(buildBashDelivery('call-sentinel', 'bash', '', 0,
      BASH_SETTLE_TIMEOUT_SENTINEL, Date.now()).status).toBe('failed');
  });
  it(
    'deliver() fires within SETTLE_AFTER_KILL_MS when close never arrives',
    async () => {
      const registry = new DetachableToolRegistry();
      const sessionAbort = new AbortController();

      // Register a token as if the bash handler had done so.
      const token: DetachToken = registry.register('call-stub');

      const delivered: DetachedToolResult[] = [];
      const deliveredPromise = new Promise<DetachedToolResult>((resolve) => {
        registry.on('settled', (r: DetachedToolResult) => {
          delivered.push(r);
          resolve(r);
        });
      });

      const { proc, stdoutDestroyed, stderrDestroyed } = makeStubbornProc();

      // Build minimal OnDetachParams — only the fields execOnDetach actually uses.
      const params: OnDetachParams = {
        resolvedRef: { value: false },
        timeoutHandle: setTimeout(() => {}, 60_000), // never fires in this test
        signal: sessionAbort.signal,
        abortHandler: () => {}, // kill is a no-op here — proc never dies naturally
        deregisterOnCloseRef: { value: undefined },
        clearTail: undefined,
        getOutput: () => 'partial output',
        proc,
        startedAt: Date.now(),
        resolve: () => {}, // tool result already resolved (we're in post-detach)
      };

      // Simulate the post-detach state: execOnDetach wires close+fallback.
      execOnDetach(token, 'sleep 30', 'call-stub', params);

      // Simulate session abort — this is what triggers the kill and starts the fallback.
      sessionAbort.abort();

      // Race: deliver() must fire within SETTLE_AFTER_KILL_MS (+2 s buffer),
      // even though proc never emits 'close'.
      const raceTimeoutMs = SETTLE_AFTER_KILL_MS + 2_000;
      const result = await Promise.race([
        deliveredPromise,
        new Promise<null>((r) => setTimeout(() => r(null), raceTimeoutMs)),
      ]);

      // The fallback must have fired — deliver() must have been called.
      expect(result).not.toBeNull();
      expect(delivered).toHaveLength(1);
      const d = delivered[0]!;

      // The fallback fires with BASH_SETTLE_TIMEOUT_SENTINEL (not 'SIGKILL') → status 'failed'.
      expect(d.status).toBe('failed');
      expect(d.toolUseId).toBe('call-stub');
      expect(d.output).toBe('partial output');

      // Stdio streams must have been destroyed to release the pipe.
      expect(stdoutDestroyed()).toBe(true);
      expect(stderrDestroyed()).toBe(true);
    },
    // Test timeout: SETTLE_AFTER_KILL_MS + 5 s headroom.
    SETTLE_AFTER_KILL_MS + 5_000,
  );

  it('normal close before abort cancels the fallback (no double-deliver)', async () => {
    const registry = new DetachableToolRegistry();
    const sessionAbort = new AbortController();
    const token: DetachToken = registry.register('call-normal');

    const delivered: DetachedToolResult[] = [];
    registry.on('settled', (r: DetachedToolResult) => delivered.push(r));

    const proc = new EventEmitter() as unknown as OnDetachParams['proc'];
    (proc as { stdout: unknown }).stdout = new EventEmitter();
    (proc as { stderr: unknown }).stderr = new EventEmitter();

    const params: OnDetachParams = {
      resolvedRef: { value: false },
      timeoutHandle: setTimeout(() => {}, 60_000),
      signal: sessionAbort.signal,
      abortHandler: () => {},
      deregisterOnCloseRef: { value: undefined },
      clearTail: undefined,
      getOutput: () => 'output',
      proc,
      startedAt: Date.now(),
      resolve: () => {},
    };

    execOnDetach(token, 'echo hi', 'call-normal', params);

    // Simulate normal process close (exitCode=0, no signal).
    proc.emit('close', 0, null);

    // Wait briefly for settle to propagate.
    await new Promise<void>((r) => setTimeout(r, 50));

    // Now fire session abort — the fallback must NOT produce a second deliver.
    sessionAbort.abort();

    // Wait for any fallback that would fire (shouldn't, but give it a moment).
    await new Promise<void>((r) => setTimeout(r, 100));

    // Only one deliver — the normal close path.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.status).toBe('completed');
  });

  it('already-aborted signal starts fallback immediately', async () => {
    const registry = new DetachableToolRegistry();
    // Pre-abort the signal before execOnDetach runs.
    const sessionAbort = new AbortController();
    sessionAbort.abort();

    const token: DetachToken = registry.register('call-preabort');

    const deliveredPromise = new Promise<DetachedToolResult>((resolve) => {
      registry.on('settled', resolve);
    });

    const proc = new EventEmitter() as unknown as OnDetachParams['proc'];
    (proc as { stdout: unknown }).stdout = { destroy: () => {} } as NodeJS.ReadableStream & { destroy(): void };
    (proc as { stderr: unknown }).stderr = { destroy: () => {} } as NodeJS.ReadableStream & { destroy(): void };

    const params: OnDetachParams = {
      resolvedRef: { value: false },
      timeoutHandle: setTimeout(() => {}, 60_000),
      signal: sessionAbort.signal,
      abortHandler: () => {},
      deregisterOnCloseRef: { value: undefined },
      clearTail: undefined,
      getOutput: () => '',
      proc,
      startedAt: Date.now(),
      resolve: () => {},
    };

    // Signal is already aborted — execOnDetach should start fallback immediately.
    execOnDetach(token, 'sleep 60', 'call-preabort', params);

    // The fallback timer fires after SETTLE_AFTER_KILL_MS; wait for it.
    const raceTimeoutMs = SETTLE_AFTER_KILL_MS + 2_000;
    const result = await Promise.race([
      deliveredPromise,
      new Promise<null>((r) => setTimeout(() => r(null), raceTimeoutMs)),
    ]);

    expect(result).not.toBeNull();
    expect((result as DetachedToolResult).status).toBe('failed');
  },
  SETTLE_AFTER_KILL_MS + 5_000,
  );

  it('close arriving before fallback timer cancels the timer (clearTimeout branch)', async () => {
    vi.useFakeTimers();
    // Exercises the path: abort fires → startSettleFallback arms the timer →
    // proc.close() arrives before SETTLE_AFTER_KILL_MS → deliverOnce runs,
    // clears the timer, removes the stale startSettleFallback listener, and
    // delivers exactly once with status 'completed'.
    const registry = new DetachableToolRegistry();
    const sessionAbort = new AbortController();
    const token: DetachToken = registry.register('call-closefirst');

    const delivered: DetachedToolResult[] = [];
    const deliveredPromise = new Promise<DetachedToolResult>((resolve) => {
      registry.on('settled', (r: DetachedToolResult) => {
        delivered.push(r);
        resolve(r);
      });
    });

    const proc = new EventEmitter() as unknown as OnDetachParams['proc'];
    (proc as { stdout: unknown }).stdout = new EventEmitter();
    (proc as { stderr: unknown }).stderr = new EventEmitter();

    const params: OnDetachParams = {
      resolvedRef: { value: false },
      timeoutHandle: setTimeout(() => {}, 60_000),
      signal: sessionAbort.signal,
      abortHandler: () => {},
      deregisterOnCloseRef: { value: undefined },
      clearTail: undefined,
      getOutput: () => 'ok output',
      proc,
      startedAt: Date.now(),
      resolve: () => {},
    };

    execOnDetach(token, 'echo hi', 'call-closefirst', params);

    // Fire session abort — this arms the fallback timer.
    sessionAbort.abort();

    // Immediately emit close (exit 0) before the 5s timer fires.
    proc.emit('close', 0, null);

    // Verify cancellation itself, not just idempotent delivery: without
    // clearTimeout the timer would remain pending despite deliverOnce's guard.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SETTLE_AFTER_KILL_MS + 1);
    const result = await deliveredPromise;

    expect(result).not.toBeNull();
    // Delivered exactly once via the close path (not the fallback).
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.status).toBe('completed');
    expect(delivered[0]!.output).toBe('ok output');
  });
});
