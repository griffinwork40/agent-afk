/**
 * Isolated spawn-mock tests for command-executor.
 *
 * Lives in its own file because vi.mock('node:child_process', …) is hoisted
 * to module scope and replaces the real spawn for the ENTIRE module graph of
 * this file. Isolating here prevents the mock from interfering with the
 * real-subprocess tests in command-executor.test.ts.
 *
 * Test purpose: verify that executeCommand uses `shell: true` in its spawn
 * call — the cross-platform fix for issue #703 (Windows compatibility).
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
    const [spawnedCommand, spawnOpts] = vi.mocked(cp.spawn).mock.calls[0] as [string, Record<string, unknown>];

    // The command string is passed as the first argument (not wrapped in sh -c).
    expect(spawnedCommand).toBe('echo hello');

    // shell: true must be present so Node resolves the OS shell itself.
    expect(spawnOpts).toMatchObject({ shell: true });
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

    // With shell: true, spawn(command, options) — the second argument is the
    // options object, not an array like ['-c', command].
    expect(Array.isArray(callArgs[1])).toBe(false);
    expect(typeof callArgs[1]).toBe('object');
  });
});
