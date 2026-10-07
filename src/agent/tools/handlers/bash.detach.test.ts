/**
 * Tests for bash tool detach contract (#2542).
 *
 * Verifies:
 *  - Normal execution is unchanged when no detachRegistry is provided.
 *  - When a detachRegistry is present and detachAll() fires BEFORE the
 *    command completes, the handler returns the detach placeholder result
 *    and the process keeps running.
 *  - deliver() is called with the real output once the process finishes.
 *  - When detachAll() fires AFTER the command has already completed (race),
 *    the command result is returned normally (settle() guard wins).
 *
 * NOTE: These tests spawn real shell processes (fast echo/sleep commands).
 * They are designed to run quickly and use short timeouts.
 *
 * @module agent/tools/handlers/bash.detach.test
 */

import { describe, expect, it } from 'vitest';
import { createBashHandler } from './bash.js';
import { DetachableToolRegistry, type DetachedToolResult } from '../detach-registry.js';
import { buildBashDelivery, SETTLE_AFTER_KILL_MS } from '../detach-bash.js';
import type { ToolHandlerContext } from '../types.js';

function makeContext(
  detachRegistry: DetachableToolRegistry,
  toolUseId: string,
): ToolHandlerContext {
  return { detachRegistry, toolUseId };
}

describe('buildBashDelivery: SIGKILL classification (Fix #3)', () => {
  it('classifies SIGKILL (closeCode=null, closeSignal=SIGKILL) as failed', () => {
    const result = buildBashDelivery('id-1', 'sleep 5', '', null, 'SIGKILL', Date.now() - 100);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBeUndefined(); // null → undefined
  });

  it('classifies clean exit (closeCode=0, closeSignal=null) as completed', () => {
    const result = buildBashDelivery('id-2', 'echo hi', 'hi', 0, null, Date.now() - 100);
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
  });

  it('classifies non-zero exit (closeCode=1, closeSignal=null) as failed', () => {
    const result = buildBashDelivery('id-3', 'exit 1', '', 1, null, Date.now() - 100);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('classifies any non-null signal as failed regardless of closeCode', () => {
    const result = buildBashDelivery('id-4', 'sleep 5', '', null, 'SIGTERM', Date.now() - 100);
    expect(result.status).toBe('failed');
  });
});

describe('bash detach contract (#2542)', () => {
  it('normal execution is unchanged when no detachRegistry is provided', async () => {
    const handler = createBashHandler('default');
    const signal = new AbortController().signal;
    const result = await handler({ command: 'echo hello' }, signal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello');
  });

  it('returns detach placeholder when detachAll() fires before the command completes', async () => {
    const handler = createBashHandler('default');
    const registry = new DetachableToolRegistry();
    const signal = new AbortController().signal;

    const context = makeContext(registry, 'call-1');

    // Start a slow command, then immediately detach before it finishes
    const handlerPromise = handler(
      { command: 'sleep 5 && echo done', timeout_ms: 10000 },
      signal,
      context,
    );

    // Give the process a moment to spawn, then fire detachAll
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    registry.detachAll();

    const result = await handlerPromise;

    // Handler must return the detach placeholder (not an error, not the real output)
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('detached');
    const parsed = JSON.parse(result.content as string) as { status: string };
    expect(parsed.status).toBe('detached');
  });

  it('deliver() receives the real output once the detached process finishes', async () => {
    const handler = createBashHandler('default');
    const registry = new DetachableToolRegistry();
    const signal = new AbortController().signal;
    const context = makeContext(registry, 'call-2');

    const deliveredResults: DetachedToolResult[] = [];
    registry.on('settled', (r: DetachedToolResult) => deliveredResults.push(r));

    // Use a short sleep so the test doesn't take long
    const handlerPromise = handler(
      { command: 'sleep 0.1 && echo detached-output', timeout_ms: 5000 },
      signal,
      context,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    registry.detachAll();

    // Handler returns immediately with placeholder
    const result = await handlerPromise;
    const parsed = JSON.parse(result.content as string) as { status: string };
    expect(parsed.status).toBe('detached');

    // Wait for the process to finish and deliver
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    expect(deliveredResults).toHaveLength(1);
    expect(deliveredResults[0]!.output).toContain('detached-output');
    expect(deliveredResults[0]!.status).toBe('completed');
    expect(deliveredResults[0]!.toolUseId).toBe('call-2');
  });

  it('returns normal result when command completes before detachAll() fires (race)', async () => {
    const handler = createBashHandler('default');
    const registry = new DetachableToolRegistry();
    const signal = new AbortController().signal;
    const context = makeContext(registry, 'call-3');

    // Command completes very quickly
    const result = await handler(
      { command: 'echo fast', timeout_ms: 5000 },
      signal,
      context,
    );

    // Fire detachAll after handler has already returned
    registry.detachAll();

    // Should be normal success result, not a detach placeholder
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('fast');
    // Not a detach placeholder
    try {
      const parsed = JSON.parse(result.content as string) as { status?: string };
      expect(parsed.status).not.toBe('detached');
    } catch {
      // Not JSON — definitely not a detach placeholder
    }
  });
});

describe('post-detach session abort kills process (Fix #1)', () => {
  it('session abort after detach kills the process and deliver() fires with failed status', async () => {
    const handler = createBashHandler('default');
    const registry = new DetachableToolRegistry();
    const sessionAbort = new AbortController();
    const context = makeContext(registry, 'call-kill');

    const deliveredResults: DetachedToolResult[] = [];
    // Use a promise to wait for settled so the test doesn't need an arbitrary sleep.
    const settledPromise = new Promise<DetachedToolResult>((resolve) => {
      registry.on('settled', (r: DetachedToolResult) => {
        deliveredResults.push(r);
        resolve(r);
      });
    });

    // Use a portable Node.js long-running command instead of `sleep 5 && echo afterwait`:
    //   - Works identically on all platforms (no POSIX `sleep` or shell `&&` required).
    //   - The sentinel string "afterwait" is written only if the process runs to
    //     completion (10 s); a kill before that leaves output empty so the
    //     post-assertion `not.toContain('afterwait')` is valid on every OS.
    //   - On Windows, `taskkill /F /T /PID` kills the bash/shell wrapper AND the
    //     spawned node.exe child reliably (both are standard Windows processes).
    //   - The 10 s handler timeout_ms ensures the process doesn't exit on its own
    //     during the test window.
    const longRunningCmd =
      'node -e "setTimeout(function(){process.stdout.write(\'afterwait\\n\')},10000)"';
    const handlerPromise = handler(
      { command: longRunningCmd, timeout_ms: 30000 },
      sessionAbort.signal,
      context,
    );

    // Spawn time — give the process a moment to start.
    // 200 ms is generous enough for slow Windows CI runners.
    await new Promise<void>((r) => setTimeout(r, 200));

    // Simulate Ctrl+B: detach all tokens (frees the model turn)
    registry.detachAll();
    const placeholderResult = await handlerPromise;

    // Handler must return the detach placeholder
    const parsed = JSON.parse(placeholderResult.content as string) as { status: string };
    expect(parsed.status).toBe('detached');

    // Now simulate session abort (AbortGraph teardown fires the session signal).
    // Fix #1: the re-registered abortHandler inside onDetach must kill the process.
    sessionAbort.abort();

    // Wait for deliver() to fire (process close after kill).
    // 10 000 ms budget: on Windows, killProcessGroup calls `taskkill /F /T /PID`
    // (synchronous), but the IOCP close-event propagation back through Node's
    // libuv adds latency on slow CI runners. 10 s is well above the observed
    // worst-case (~2-3 s) while keeping the test meaningfully bounded.
    const settled = await Promise.race([
      settledPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 10000)),
    ]);

    // deliver() must have been called — the process was killed, not orphaned
    expect(settled).not.toBeNull();
    expect(deliveredResults).toHaveLength(1);

    // The process was killed before completing (Fix #3 → status 'failed').
    // Output must NOT contain 'afterwait' (the deferred write never ran).
    expect(deliveredResults[0]!.status).toBe('failed');
    expect(deliveredResults[0]!.output).not.toContain('afterwait');
  });

  it(
    'POSIX-utility child (sleep): deliver() fires via kill or settle-fallback (#2742)',
    async () => {
      // Regression test for #2742: on Windows, `taskkill /F /T` may not reach
      // MSYS2 (Git Bash) grandchildren such as sleep.exe, leaving the pipe open
      // so `close` never fires. The settle-fallback in execOnDetach must then
      // fire deliver() after SETTLE_AFTER_KILL_MS.
      //
      // On POSIX: process.kill(-pid, SIGKILL) kills the whole process group;
      // `close` fires quickly (<200 ms in practice); test completes well
      // within the timeout window.
      //
      // On Windows (Git Bash): sleep.exe may survive taskkill /T; the settle
      // fallback fires after SETTLE_AFTER_KILL_MS (5 s) and delivers with
      // status 'failed'. The test budget is SETTLE_AFTER_KILL_MS + 10 s.
      //
      // In both cases deliver() must have been called before the race window
      // closes — that is the invariant being tested.
      const handler = createBashHandler('default');
      const registry = new DetachableToolRegistry();
      const sessionAbort = new AbortController();
      const context = makeContext(registry, 'call-posix-child');

      const deliveredResults: DetachedToolResult[] = [];
      const settledPromise = new Promise<DetachedToolResult>((resolve) => {
        registry.on('settled', (r: DetachedToolResult) => {
          deliveredResults.push(r);
          resolve(r);
        });
      });

      // `sleep 30` is a POSIX-utility (or MSYS2 sleep.exe on Windows via Git
      // Bash). On POSIX the process group kill reaches it; on Windows it is the
      // exact process class that may survive taskkill /T (the #2742 scenario).
      // The 30 s duration ensures it never exits naturally during the test.
      const handlerPromise = handler(
        { command: 'sleep 30', timeout_ms: 60000 },
        sessionAbort.signal,
        context,
      );

      // Generous spawn wait — 200 ms is enough even on slow Windows CI runners.
      await new Promise<void>((r) => setTimeout(r, 200));

      // Ctrl+B: detach all tokens.
      registry.detachAll();
      const placeholderResult = await handlerPromise;

      const parsed = JSON.parse(placeholderResult.content as string) as { status: string };
      expect(parsed.status).toBe('detached');

      // Session abort: triggers killProcessGroup (taskkill on Windows) and arms
      // the settle-fallback timer in execOnDetach (SETTLE_AFTER_KILL_MS = 5 s).
      sessionAbort.abort();

      // Race window:
      //   POSIX  — close fires in < 200 ms after SIGKILL
      //   Windows — either close fires after taskkill, OR the settle-fallback
      //             fires after SETTLE_AFTER_KILL_MS (5 s)
      // Budget: SETTLE_AFTER_KILL_MS + 10 s headroom.
      const raceMs = SETTLE_AFTER_KILL_MS + 10_000;
      const settled = await Promise.race([
        settledPromise,
        new Promise<null>((r) => setTimeout(() => r(null), raceMs)),
      ]);

      // deliver() must have been called — process killed or fallback fired.
      expect(settled).not.toBeNull();
      expect(deliveredResults).toHaveLength(1);
      // Killed or fallback → status must be 'failed'.
      expect(deliveredResults[0]!.status).toBe('failed');
    },
    // Vitest timeout: SETTLE_AFTER_KILL_MS + 15 s so the test body's race
    // (SETTLE_AFTER_KILL_MS + 10 s) always has a 5 s margin before Vitest
    // kills the test itself.
    SETTLE_AFTER_KILL_MS + 15_000,
  );

  it('normal-close deregisters token so hasDetachable() becomes false', async () => {
    const handler = createBashHandler('default');
    const registry = new DetachableToolRegistry();
    const signal = new AbortController().signal;
    const context = makeContext(registry, 'call-norm');

    // Command completes normally (no detach)
    await handler({ command: 'echo hello', timeout_ms: 5000 }, signal, context);

    // Fix #2: token must be cleaned up after normal close
    expect(registry.hasDetachable()).toBe(false);
    expect(registry.listRunning()).toEqual([]);
  });
});
