/**
 * Tests that background process spawns are routed through the OS-level sandbox
 * when AFK_BASH_SANDBOX is set, and bypass it when unset (issue #3845).
 *
 * Uses the same mocking pattern as bash.spawn.test.ts: mock child_process.spawn
 * and bash-sandbox so we verify the wiring, not the sandbox internals.
 *
 * @module agent/shell-jobs/process-launcher.sandbox.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  build: vi.fn(() => ({
    shell: 'sandbox-backend',
    args: ['-p', 'fake-profile'],
    command: 'true',
    sandboxed: true,
  })),
  sandboxDescription: vi.fn(() => 'sandbox: mock (workspace-write)'),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('../tools/handlers/bash-sandbox.js', () => ({
  buildSandboxedCommand: mocks.build,
  sandboxDescription: mocks.sandboxDescription,
  // SandboxPolicy is a type; no runtime export needed
}));

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Minimal ProcessLogSink stand-in. launchProcess writes to it but we only
 * care about the spawn call, so stubs suffice.
 */
function makeSink() {
  return {
    write: vi.fn(),
    close: vi.fn(),
    tail: vi.fn(() => ''),
    totalBytes: 0,
    lastError: undefined,
  };
}

/**
 * A mock ChildProcess with the event surface launchProcess needs.
 * Returns an object whose `emit` lets tests drive the process lifecycle.
 */
function makeProc() {
  type Handler = (...args: unknown[]) => void;
  const handlers: Record<string, Handler[]> = {};
  const proc = {
    pid: 42,
    unref: vi.fn(),
    stdout: { on: vi.fn(), destroy: vi.fn() },
    stderr: { on: vi.fn(), destroy: vi.fn() },
    once(event: string, fn: Handler) { (handlers[event] ??= []).push(fn); return proc; },
    emit(event: string, ...args: unknown[]) { for (const h of handlers[event] ?? []) h(...args); },
  };
  return proc;
}

// ── Tests ─────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.clearAllMocks();
});

describe('process-launcher sandbox wiring', () => {
  it('calls buildSandboxedCommand and spawns sandbox binary when sandboxPolicy is set', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);

    const { launchProcess } = await import('./process-launcher.js');

    const sink = makeSink();
    const launched = launchProcess({
      command: 'echo hello',
      cwd: '/synthetic/cwd',
      env: { TMPDIR: '/synthetic/tmp' },
      sink: sink as never,
      sandboxPolicy: 'workspace-write',
    });

    // sandbox builder must have been called with correct cwd and temp
    expect(mocks.build).toHaveBeenCalledWith(
      'echo hello',
      'workspace-write',
      '/synthetic/cwd',
      '/synthetic/tmp',
    );

    // spawn must receive the sandbox binary and its args, not the raw command
    expect(mocks.spawn).toHaveBeenCalledWith(
      'sandbox-backend',
      ['-p', 'fake-profile', 'true'],
      expect.objectContaining({ env: { TMPDIR: '/synthetic/tmp' } }),
    );

    // settle the process so the test doesn't leak
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    await launched.exited;
  });

  it('falls back to POSIX /tmp when env carries no TMPDIR/TMP/TEMP', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);

    const { launchProcess } = await import('./process-launcher.js');

    const sink = makeSink();
    const launched = launchProcess({
      command: 'true',
      cwd: '/synthetic/cwd',
      env: {},
      sink: sink as never,
      sandboxPolicy: 'read-only',
    });

    expect(mocks.build).toHaveBeenCalledWith('true', 'read-only', '/synthetic/cwd', '/tmp');

    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    await launched.exited;
  });

  it('uses process.cwd() when no cwd is provided', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);

    const { launchProcess } = await import('./process-launcher.js');

    const sink = makeSink();
    const launched = launchProcess({
      command: 'true',
      env: { TMPDIR: '/synthetic/tmp' },
      sink: sink as never,
      sandboxPolicy: 'workspace-write',
    });

    expect(mocks.build).toHaveBeenCalledWith('true', 'workspace-write', process.cwd(), '/synthetic/tmp');

    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    await launched.exited;
  });

  it('does NOT call buildSandboxedCommand when sandboxPolicy is omitted', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);

    const { launchProcess } = await import('./process-launcher.js');

    const sink = makeSink();
    const launched = launchProcess({
      command: 'true',
      env: {},
      sink: sink as never,
      // no sandboxPolicy
    });

    expect(mocks.build).not.toHaveBeenCalled();
    // spawn is still called (unsandboxed path)
    expect(mocks.spawn).toHaveBeenCalled();

    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    await launched.exited;
  });

  it('does NOT call buildSandboxedCommand when sandboxPolicy is "off"', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);

    const { launchProcess } = await import('./process-launcher.js');

    const sink = makeSink();
    const launched = launchProcess({
      command: 'true',
      env: {},
      sink: sink as never,
      sandboxPolicy: 'off',
    });

    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalled();

    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    await launched.exited;
  });

  it('propagates buildSandboxedCommand refusal without spawning unsandboxed', async () => {
    mocks.build.mockImplementationOnce(() => {
      throw new Error('Sandbox backend unavailable');
    });
    // spawn should NOT be called at all
    mocks.spawn.mockReturnValue(makeProc());

    const { launchProcess } = await import('./process-launcher.js');

    const sink = makeSink();
    const launched = launchProcess({
      command: 'true',
      env: {},
      sink: sink as never,
      sandboxPolicy: 'workspace-write',
    });

    // spawnLeader throws → launchProcess catches and settles with spawnError
    const result = await launched.exited;
    expect(result.spawnError).toMatch('Sandbox backend unavailable');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe('ProcessJobRegistry sandbox wiring', () => {
  it('passes parseSandboxPolicy() result to launchProcess when AFK_BASH_SANDBOX is set', async () => {
    vi.resetModules();

    const mockLaunchProcess = vi.fn(() => ({
      pid: 99,
      exited: new Promise<never>(() => {}),
      isLive: () => true,
      leaderExited: () => false,
      signalGroup: vi.fn(),
    }));

    vi.doMock('./process-launcher.js', () => ({
      launchProcess: mockLaunchProcess,
      terminateWithGrace: vi.fn(),
    }));

    vi.doMock('../tools/handlers/bash-sandbox.js', () => ({
      parseSandboxPolicy: () => 'workspace-write' as const,
      buildSandboxedCommand: mocks.build,
      sandboxDescription: mocks.sandboxDescription,
    }));

    const { ProcessJobRegistry } = await import('./process-jobs.js');
    const reg = new ProcessJobRegistry({ logDir: '/tmp', sweep: false });
    reg.start({ command: 'true', env: {} });

    expect(mockLaunchProcess).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxPolicy: 'workspace-write' }),
    );
  });

  it('omits sandboxPolicy from launchProcess when AFK_BASH_SANDBOX is unset', async () => {
    vi.resetModules();

    const mockLaunchProcess = vi.fn(() => ({
      pid: 99,
      exited: new Promise<never>(() => {}),
      isLive: () => true,
      leaderExited: () => false,
      signalGroup: vi.fn(),
    }));

    vi.doMock('./process-launcher.js', () => ({
      launchProcess: mockLaunchProcess,
      terminateWithGrace: vi.fn(),
    }));

    vi.doMock('../tools/handlers/bash-sandbox.js', () => ({
      parseSandboxPolicy: () => undefined,
      buildSandboxedCommand: mocks.build,
      sandboxDescription: mocks.sandboxDescription,
    }));

    const { ProcessJobRegistry } = await import('./process-jobs.js');
    const reg = new ProcessJobRegistry({ logDir: '/tmp', sweep: false });
    reg.start({ command: 'true', env: {} });

    // sandboxPolicy key must NOT be present (not even undefined) so callers
    // that check `'sandboxPolicy' in opts` get a clean false.
    const callArg = (mockLaunchProcess.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect('sandboxPolicy' in callArg).toBe(false);
  });
});
