/**
 * Isolated spawn-mock tests for command-executor.
 *
 * Lives in its own file because vi.mock('node:child_process', …) is hoisted
 * to module scope and replaces the real spawn for the ENTIRE module graph of
 * this file. Isolating here prevents the mock from interfering with the
 * real-subprocess tests in command-executor.test.ts.
 *
 * Test purposes:
 *   1. Verify that executeCommand uses `shell: true` in its spawn call —
 *      the cross-platform fix for issue #703 (Windows compatibility).
 *   2. Regression for the "silent exit 0" bug: proc.unref() must be called
 *      AFTER the process closes, not immediately after spawn. With detached:true,
 *      calling proc.unref() immediately also unrefs the child's stdio pipes, so
 *      if no other handles hold the event loop (e.g. no MCP server processes),
 *      Node exits before the 'close' callback fires and the Promise never settles.
 *
 * NOTE: vi.mock() factories are hoisted above all imports/variable declarations
 * by vitest, so the factory cannot reference variables declared in this file.
 * Use vi.fn() inline and retrieve the mock via vi.mocked() after import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock node:child_process before importing the module under test.
// vi.mock is hoisted above all imports by vitest, so the factory must NOT
// reference any variable declared in this file (hoisting invariant).
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// killProcessGroup is called on timeout — stub it to avoid real process logic.
vi.mock('../../utils/kill-process-group.js', () => ({
  killProcessGroup: vi.fn(),
}));

// Import after mocks are registered.
import * as cp from 'node:child_process';
import { executeCommand } from './command-executor.js';
import type { HookContext } from '../hooks.js';
// resolveShell is used on Windows to determine the spawn shape.
import { resolveShell } from '../../utils/resolve-shell.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal fake ChildProcess that satisfies the executor's
// event-listener surface (stdout, stderr, stdin, close, error).
// ---------------------------------------------------------------------------

function makeFakeProc() {
  const proc = new EventEmitter();

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_data: unknown, cb?: () => void) => { cb?.(); return true; }),
    end: vi.fn(),
  });

  Object.assign(proc, {
    pid: 12345,
    stdout,
    stderr,
    stdin,
    unref: vi.fn(),
  });

  return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regression: proc.unref() must be deferred until after settlement
// ---------------------------------------------------------------------------
//
// Root cause of the "silent exit 0" bug: with detached:true, calling
// proc.unref() immediately after spawn() unrefs the child's stdio pipes as well
// as the child handle. If no other active handles exist (e.g. no MCP server
// child processes keeping the event loop alive), Node drains the event loop and
// exits before the 'close' callback fires — the Promise never settles and
// sendMessage never fires.
//
// The fix: defer proc.unref() to settle(), called from 'close'/'error' handlers.
// This keeps stdio pipes referenced (and the event loop alive) for exactly as
// long as we need them, and unrefs the child once we have our result.

describe('proc.unref() timing (regression for silent-exit-0 bug)', () => {
  let fakeProc: ReturnType<typeof makeFakeProc>;

  beforeEach(() => {
    fakeProc = makeFakeProc();
    vi.mocked(cp.spawn).mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(cp.spawn).mockReturnValue(fakeProc as any);
  });

  it('does NOT call proc.unref() before the process closes', async () => {
    const context: HookContext = { event: 'SessionStart', sessionId: 'test' };
    const resultPromise = executeCommand({
      command: 'echo hello',
      context,
      agentCwd: '/tmp',
      sessionId: 'test',
      timeoutMs: 5_000,
    });

    // At this point the process is "running" — unref() must NOT have been
    // called yet. If it were called immediately after spawn (the bug), the
    // child's stdio pipes would be unreffed and in a no-other-handles scenario
    // the event loop could drain before 'close' fires.
    expect(vi.mocked(fakeProc.unref)).not.toHaveBeenCalled();

    // Now simulate the process finishing.
    fakeProc.emit('close', 0);
    await resultPromise;

    // unref() must have been called exactly once, AFTER the process closed.
    expect(vi.mocked(fakeProc.unref)).toHaveBeenCalledOnce();
  });

  it('calls proc.unref() after an error event as well', async () => {
    const context: HookContext = { event: 'SessionStart', sessionId: 'test' };
    const resultPromise = executeCommand({
      command: 'bad-command',
      context,
      agentCwd: '/tmp',
      sessionId: 'test',
      timeoutMs: 5_000,
    });

    expect(vi.mocked(fakeProc.unref)).not.toHaveBeenCalled();

    fakeProc.emit('error', new Error('ENOENT: bad-command not found'));
    await resultPromise;

    expect(vi.mocked(fakeProc.unref)).toHaveBeenCalledOnce();
  });
});

describe('spawn call — shell: true (cross-platform fix #703)', () => {
  let fakeProc: ReturnType<typeof makeFakeProc>;

  beforeEach(() => {
    fakeProc = makeFakeProc();
    vi.mocked(cp.spawn).mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(cp.spawn).mockReturnValue(fakeProc as any);
  });

  it('passes `shell: true` in the spawn options', async () => {
    const context: HookContext = { event: 'SessionStart', sessionId: 'test' };

    const resultPromise = executeCommand({
      command: 'echo hello',
      context,
      agentCwd: '/tmp',
      sessionId: 'test',
      timeoutMs: 5_000,
    });

    // Drive the fake process to close with exit 0 so the executor settles.
    fakeProc.emit('close', 0);

    await resultPromise;

    expect(vi.mocked(cp.spawn)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(cp.spawn).mock.calls[0] as [string, unknown, Record<string, unknown>?];

    if (process.platform === 'win32') {
      // On Windows the executor uses resolveShell() to pick Git Bash or PowerShell.
      // spawn(shell, ['-c', command], opts) — first arg is the shell path, second is an array.
      const { shell } = resolveShell();
      expect(callArgs[0]).toBe(shell); // gitBash path or 'powershell.exe'
      expect(Array.isArray(callArgs[1])).toBe(true); // ['-c', 'echo hello']
    } else {
      // On POSIX: spawn(command, { shell: true, ... }) — command is the raw string.
      expect(callArgs[0]).toBe('echo hello');
      // shell: true must be present so Node resolves the OS shell itself.
      expect(callArgs[1]).toMatchObject({ shell: true });
    }
  });

  it('does NOT pass an args array as the second argument (no sh -c)', async () => {
    const context: HookContext = { event: 'SessionStart', sessionId: 'test' };

    const resultPromise = executeCommand({
      command: 'exit 0',
      context,
      agentCwd: '/tmp',
      sessionId: 'test',
      timeoutMs: 5_000,
    });

    fakeProc.emit('close', 0);
    await resultPromise;

    expect(vi.mocked(cp.spawn)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(cp.spawn).mock.calls[0];

    if (process.platform === 'win32') {
      // On Windows: spawn(shell, ['-c', command], opts) — second arg IS an array.
      const { shell } = resolveShell();
      expect(callArgs[0]).toBe(shell); // gitBash or powershell path
      expect(Array.isArray(callArgs[1])).toBe(true); // ['-c', command]
    } else {
      // On POSIX: spawn(command, options) — the second argument is the
      // options object, not an array like ['-c', command].
      expect(Array.isArray(callArgs[1])).toBe(false);
      expect(typeof callArgs[1]).toBe('object');
    }
  });
});
