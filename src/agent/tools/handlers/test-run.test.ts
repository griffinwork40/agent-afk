/**
 * Unit tests for test-run.ts handler.
 *
 * Strategy: mock `discoverTestCommand` and child_process.spawn so tests run
 * fast and deterministically. Separate tests verify:
 * - structured result shape when a command succeeds / fails
 * - testResult aggregate (from detectTestResult)
 * - failures array (from parseTestFailures)
 * - timeout behavior
 * - discovery-not-found path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Mock child_process.spawn BEFORE importing the handler
// ---------------------------------------------------------------------------

vi.mock('child_process', () => {
  return { spawn: vi.fn() };
});

// Mock killProcessGroup so tests don't actually kill OS processes
vi.mock('../../../utils/kill-process-group.js', () => ({
  killProcessGroup: vi.fn(),
}));

vi.mock('./test-run-discovery.js', () => ({
  discoverTestCommand: vi.fn(),
}));

import { spawn } from 'child_process';
import { testRunHandler } from './test-run.js';
import { discoverTestCommand } from './test-run-discovery.js';

const mockSpawn = vi.mocked(spawn);
const mockDiscover = vi.mocked(discoverTestCommand);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProc(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorOnSpawn?: Error;
}): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    unref: () => void;
  };
  proc.pid = 12345;
  proc.unref = vi.fn();
  proc.stdout = new EventEmitter() as EventEmitter;
  proc.stderr = new EventEmitter() as EventEmitter;

  setImmediate(() => {
    if (options.errorOnSpawn) {
      (proc as EventEmitter).emit('error', options.errorOnSpawn);
      return;
    }
    if (options.stdout) {
      (proc.stdout as EventEmitter).emit('data', Buffer.from(options.stdout));
    }
    if (options.stderr) {
      (proc.stderr as EventEmitter).emit('data', Buffer.from(options.stderr));
    }
    (proc as EventEmitter).emit('close', options.exitCode ?? 0);
  });

  return proc as ChildProcess;
}

function makeAbort() {
  return new AbortController();
}

const VITEST_DISCOVERY = {
  runner: 'vitest' as const,
  command: 'pnpm run test',
  args: ['pnpm', 'run', 'test'],
};

const PYTEST_DISCOVERY = {
  runner: 'pytest' as const,
  command: 'pytest',
  args: ['pytest'],
};

// ---------------------------------------------------------------------------
// Discovery not found
// ---------------------------------------------------------------------------

describe('test_run: no test command found', () => {
  it('returns isError when discovery returns null', async () => {
    mockDiscover.mockReturnValueOnce(null);

    const ctrl = makeAbort();
    const result = await testRunHandler({}, ctrl.signal, { resolveBase: '/nonexistent' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/No test command found/i);
  });
});

// ---------------------------------------------------------------------------
// Successful test run
// ---------------------------------------------------------------------------

describe('test_run: successful run', () => {
  beforeEach(() => {
    mockDiscover.mockReturnValue(VITEST_DISCOVERY);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns content with summary line', async () => {
    mockSpawn.mockReturnValue(
      makeProc({ stdout: 'Tests  5 passed (5)\n', exitCode: 0 }),
    );

    const ctrl = makeAbort();
    const result = await testRunHandler({}, ctrl.signal);
    expect(result.content).toContain('5 passed');
    expect(result.isError).toBeFalsy();
  });

  it('attaches testResult to structured output', async () => {
    mockSpawn.mockReturnValue(
      makeProc({ stdout: 'Tests  5 passed (5)\n', exitCode: 0 }),
    );

    const ctrl = makeAbort();
    const result = await testRunHandler({}, ctrl.signal);
    expect(result.testResult).toBeDefined();
    expect(result.testResult!.passed).toBe(5);
    expect(result.testResult!.failed).toBe(0);
    expect(result.testResult!.runner).toBe('vitest');
  });

  it('includes command in content', async () => {
    mockSpawn.mockReturnValue(
      makeProc({ stdout: 'Tests  3 passed (3)\n', exitCode: 0 }),
    );

    const ctrl = makeAbort();
    const result = await testRunHandler({}, ctrl.signal);
    expect(result.content).toContain('pnpm run test');
  });

  it('includes duration in content', async () => {
    mockSpawn.mockReturnValue(
      makeProc({ stdout: 'Tests  1 passed (1)\n', exitCode: 0 }),
    );

    const ctrl = makeAbort();
    const result = await testRunHandler({}, ctrl.signal);
    expect(result.content).toMatch(/\d+ms/);
  });
});

// ---------------------------------------------------------------------------
// Failed test run
// ---------------------------------------------------------------------------

describe('test_run: failed run', () => {
  beforeEach(() => {
    mockDiscover.mockReturnValue(VITEST_DISCOVERY);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError when exit code != 0', async () => {
    mockSpawn.mockReturnValue(
      makeProc({ stdout: 'Tests  2 passed | 1 failed (3)\n', exitCode: 1 }),
    );

    const ctrl = makeAbort();
    const result = await testRunHandler({}, ctrl.signal);
    expect(result.isError).toBe(true);
  });

  it('sets testResult.failed > 0', async () => {
    mockSpawn.mockReturnValue(
      makeProc({ stdout: 'Tests  2 passed | 1 failed (3)\n', exitCode: 1 }),
    );

    const ctrl = makeAbort();
    const result = await testRunHandler({}, ctrl.signal);
    expect(result.testResult).toBeDefined();
    expect(result.testResult!.failed).toBe(1);
    expect(result.testResult!.passed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('test_run: timeout', () => {
  beforeEach(() => {
    mockDiscover.mockReturnValue(PYTEST_DISCOVERY);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns isError with timeout message on timeout', async () => {
    // Make a process that never completes
    const proc = new EventEmitter() as unknown as ChildProcess & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      unref: () => void;
    };
    proc.pid = 9999;
    proc.unref = vi.fn();
    proc.stdout = new EventEmitter() as EventEmitter;
    proc.stderr = new EventEmitter() as EventEmitter;
    mockSpawn.mockReturnValue(proc as ChildProcess);

    const ctrl = makeAbort();
    // Use a very short timeout (10ms) so the test is fast
    const result = await testRunHandler({ timeout_ms: 10 }, ctrl.signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out/i);
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe('test_run: abort signal', () => {
  it('returns abort result when signal is already aborted', async () => {
    const ctrl = makeAbort();
    ctrl.abort();

    const result = await testRunHandler({}, ctrl.signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/abort/i);
  });
});

// ---------------------------------------------------------------------------
// File + name narrowing
// ---------------------------------------------------------------------------

describe('test_run: file and name narrowing', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes file arg to spawn argv for vitest', async () => {
    mockDiscover.mockReturnValue(VITEST_DISCOVERY);
    mockSpawn.mockReturnValue(
      makeProc({ stdout: 'Tests  1 passed (1)\n', exitCode: 0 }),
    );

    const ctrl = makeAbort();
    await testRunHandler({ file: 'src/foo.test.ts', name: 'my test' }, ctrl.signal);

    expect(mockSpawn).toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining(['src/foo.test.ts', '--testNamePattern', 'my test']),
      expect.any(Object),
    );
  });

  it('passes -k flag for pytest with name', async () => {
    mockDiscover.mockReturnValue(PYTEST_DISCOVERY);
    mockSpawn.mockReturnValue(
      makeProc({ stdout: '= 1 passed in 0.01s =', exitCode: 0 }),
    );

    const ctrl = makeAbort();
    await testRunHandler({ name: 'test_add' }, ctrl.signal);

    expect(mockSpawn).toHaveBeenCalledWith(
      'pytest',
      expect.arrayContaining(['-k', 'test_add']),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// Context.resolveBase used as cwd
// ---------------------------------------------------------------------------

describe('test_run: context.resolveBase', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('discovers from resolveBase path', async () => {
    mockDiscover.mockReturnValue(null);

    const ctrl = makeAbort();
    await testRunHandler({}, ctrl.signal, { resolveBase: '/my/project' });

    expect(mockDiscover).toHaveBeenCalledWith('/my/project');
  });

  it('falls back to process.cwd() when no context', async () => {
    mockDiscover.mockReturnValue(null);

    const ctrl = makeAbort();
    await testRunHandler({}, ctrl.signal);

    expect(mockDiscover).toHaveBeenCalledWith(process.cwd());
  });
});

// ---------------------------------------------------------------------------
// Coverage flag
// ---------------------------------------------------------------------------

describe('test_run: coverage flag', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('adds --coverage to vitest argv when coverage=true', async () => {
    mockDiscover.mockReturnValue(VITEST_DISCOVERY);
    mockSpawn.mockReturnValue(
      makeProc({ stdout: 'Tests  1 passed (1)\n', exitCode: 0 }),
    );

    const ctrl = makeAbort();
    await testRunHandler({ coverage: true }, ctrl.signal);

    expect(mockSpawn).toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining(['--coverage']),
      expect.any(Object),
    );
  });
});
