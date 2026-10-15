// Regression (#703 Windows leg): shell-task.ts previously hardcoded
// `/bin/sh -c`, which throws `ENOENT` on Windows. This file verifies that
// on win32 the shell is resolved via `resolveShell()` (Git Bash first,
// PowerShell fallback), and that POSIX behaviour is unchanged.
//
// Strategy: mock `../../utils/resolve-shell` to inject win32 shell
// resolutions, and mock `node:child_process` at the callback level so the
// promisify wrapper in the module under test picks up the mock. This lets
// the test run on any host OS without Git Bash or PowerShell installed.
//
// Precedent: PR #2605 src/agent/tools/handlers/bash-scan-exempt.win32.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock resolveShell so we can inject win32 shell resolutions at test time.
// Hoisted before any dynamic import.
// ---------------------------------------------------------------------------
vi.mock('../../utils/resolve-shell.js', () => ({
  resolveShell: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock child_process.execFile at the callback level.
//
// Contract: promisify(execFileCb) captures the execFile reference at module-
// load time. vi.mock() is hoisted, so the mock is installed before shell-
// task.ts is imported and promisify wraps the mock. The mock must be callback-
// style (last arg is a (err, stdout, stderr) callback) — a Promise-returning
// mock would hang because promisify never receives the callback invocation.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

// Dynamic imports are required: vi.mock() is hoisted; the module under test
// must be imported after the mocks are in place so promisify() wraps the stub.
const { resolveShell } = await import('../../utils/resolve-shell.js');
const cpMod = await import('node:child_process');
const { runShellTask } = await import('./shell-task.js');

const mockResolveShell = resolveShell as ReturnType<typeof vi.fn>;
// The raw execFile mock (callback-style) installed above.
const rawExecFileMock = cpMod.execFile as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTelemetryCollector() {
  const records: unknown[] = [];
  return {
    records,
    writeTelemetry: (r: unknown) => records.push(r),
  };
}

type ExecFileCallback = (
  err: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string,
) => void;

/**
 * Configure rawExecFileMock to call its last argument (the promisify callback)
 * with a success result.
 */
function stubExecFileSuccess(stdout = 'ok\n', stderr = ''): void {
  rawExecFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      setImmediate(() => cb(null, stdout, stderr));
    },
  );
}

/**
 * Configure rawExecFileMock to call its last argument with a nonzero-exit error
 * (the shape execFile produces on a failed command — err carries stdout/stderr).
 */
function stubExecFileFailure(exitCode: number, stdout = '', stderr = ''): void {
  rawExecFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      const err = Object.assign(new Error(`Command failed with exit code ${exitCode}`), {
        code: exitCode,
        killed: false,
        stdout,
        stderr,
      }) as NodeJS.ErrnoException;
      setImmediate(() => cb(err, stdout, stderr));
    },
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Win32 — Git Bash resolution
// ---------------------------------------------------------------------------

describe('shell-task on win32 with Git Bash', () => {
  const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

  it('passes the Git Bash path and -c flag to execFile', async () => {
    mockResolveShell.mockReturnValue({ shell: GIT_BASH, args: ['-c'] });
    stubExecFileSuccess('hello\n');

    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'win-bash', command: 'echo hello' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('success');
    expect(rawExecFileMock).toHaveBeenCalledOnce();
    const [shell, args] = rawExecFileMock.mock.calls[0] as [string, string[]];
    expect(shell).toBe(GIT_BASH);
    expect(args).toEqual(['-c', 'echo hello']);
  });

  it('returns status:error and "exit N" when Git Bash exits nonzero', async () => {
    mockResolveShell.mockReturnValue({ shell: GIT_BASH, args: ['-c'] });
    stubExecFileFailure(42, '', 'something went wrong');

    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'win-bash-fail', command: 'exit 42' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toBe('exit 42');
  });
});

// ---------------------------------------------------------------------------
// 2. Win32 — PowerShell fallback (no Git Bash found)
// ---------------------------------------------------------------------------

describe('shell-task on win32 with PowerShell fallback', () => {
  it('passes powershell.exe and -Command flag to execFile', async () => {
    mockResolveShell.mockReturnValue({ shell: 'powershell.exe', args: ['-Command'] });
    stubExecFileSuccess('ps-output\n');

    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'win-ps', command: 'Write-Output hello' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('success');
    expect(rawExecFileMock).toHaveBeenCalledOnce();
    const [shell, args] = rawExecFileMock.mock.calls[0] as [string, string[]];
    expect(shell).toBe('powershell.exe');
    expect(args).toEqual(['-Command', 'Write-Output hello']);
  });
});

// ---------------------------------------------------------------------------
// 3. POSIX — shell: true resolves to /bin/sh (unchanged behaviour)
// ---------------------------------------------------------------------------

describe('shell-task on POSIX', () => {
  it('passes /bin/sh and -c to execFile when resolveShell returns { shell: true }', async () => {
    // resolveShell() returns { shell: true } on POSIX platforms.
    mockResolveShell.mockReturnValue({ shell: true });
    stubExecFileSuccess('posix\n');

    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'posix', command: 'echo posix' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('success');
    expect(rawExecFileMock).toHaveBeenCalledOnce();
    const [shell, args] = rawExecFileMock.mock.calls[0] as [string, string[]];
    // POSIX: explicit /bin/sh so execFile behaviour is identical to the
    // previous hard-coded call and POSIX behaviour is byte-identical.
    expect(shell).toBe('/bin/sh');
    expect(args).toEqual(['-c', 'echo posix']);
  });
});

// ---------------------------------------------------------------------------
// 4. Shell args forwarded correctly when resolveShell provides no args field
// ---------------------------------------------------------------------------

describe('shell-task — args fallback', () => {
  it('uses empty prefix args when resolution provides no args field', async () => {
    // Contrived: a custom shell that needs no prefix args.
    mockResolveShell.mockReturnValue({ shell: '/custom/sh' });
    stubExecFileSuccess('custom\n');

    const col = makeTelemetryCollector();
    await runShellTask(
      { taskId: 'custom-shell', command: 'do-thing' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(rawExecFileMock).toHaveBeenCalledOnce();
    const [shell, args] = rawExecFileMock.mock.calls[0] as [string, string[]];
    expect(shell).toBe('/custom/sh');
    // No prefix args — array contains only the command string.
    expect(args).toEqual(['do-thing']);
  });
});
