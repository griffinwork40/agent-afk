/**
 * Integration tests for the wait_for handler.
 *
 * Tests input validation, SSRF rejection, and end-to-end handler wiring.
 * The poll loop is mocked to resolve immediately.
 *
 * @module agent/tools/handlers/wait-for.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the egress guard
// ---------------------------------------------------------------------------
vi.mock('../../../web/egress-guard.js', () => ({
  checkEgressTarget: vi.fn().mockResolvedValue({ allowed: true }),
  assertEgressAllowed: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock the condition evaluators so they resolve immediately
// ---------------------------------------------------------------------------
vi.mock('./wait-for-conditions.js', () => ({
  evaluateUrl: vi.fn().mockResolvedValue({ met: true, detail: 'HTTP 200' }),
  evaluateFile: vi.fn().mockResolvedValue({ met: true, detail: 'file exists (10 bytes)' }),
  evaluateProcess: vi.fn().mockReturnValue({ met: true, detail: 'pid 12345 has exited' }),
  evaluateCommand: vi.fn().mockReturnValue({ met: true, detail: 'command exited 0' }),
}));

// ---------------------------------------------------------------------------
// Mock sleepWithAbort (poll loop sleep)
// ---------------------------------------------------------------------------
vi.mock('../../providers/shared/sleep-with-abort.js', () => ({
  sleepWithAbort: vi.fn().mockResolvedValue(undefined),
}));

import { waitForHandler } from './wait-for.js';
import { checkEgressTarget } from '../../../web/egress-guard.js';

const mockCheckEgress = vi.mocked(checkEgressTarget);

const neverSignal = new AbortController().signal;

describe('waitForHandler — input validation', () => {
  it('returns error when input is not an object', async () => {
    const result = await waitForHandler('bad', neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/object/);
  });

  it('returns error when type is missing', async () => {
    const result = await waitForHandler({}, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/type/);
  });

  it('returns error for unknown type', async () => {
    const result = await waitForHandler({ type: 'magic' }, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Unknown type/);
  });

  it('returns error when url type missing url field', async () => {
    const result = await waitForHandler({ type: 'url' }, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/"url"/);
  });

  it('returns error when file type missing path field', async () => {
    const result = await waitForHandler({ type: 'file' }, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/"path"/);
  });

  it('returns error when process type missing pid field', async () => {
    const result = await waitForHandler({ type: 'process' }, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/"pid"/);
  });

  it('returns error when command type missing command field', async () => {
    const result = await waitForHandler({ type: 'command' }, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/"command"/);
  });

  it('returns error when method is invalid', async () => {
    const result = await waitForHandler({ type: 'url', url: 'https://x.com', method: 'POST' }, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/method/);
  });

  it('returns error when backoff is invalid', async () => {
    const result = await waitForHandler({ type: 'command', command: 'true', backoff: 'cubic' }, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/backoff/);
  });

  it('returns error when process pid is not a positive integer', async () => {
    const result = await waitForHandler({ type: 'process', pid: -1 }, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/pid/);
  });

  it('returns error when timeout_ms is not a number', async () => {
    const result = await waitForHandler({ type: 'command', command: 'true', timeout_ms: 'long' }, neverSignal);
    expect(result.isError).toBe(true);
  });
});

describe('waitForHandler — SSRF guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEgress.mockResolvedValue({ allowed: true });
  });

  it('blocks private IP and returns error', async () => {
    mockCheckEgress.mockResolvedValue({ allowed: false, reason: 'loopback/private address' });
    const result = await waitForHandler({ type: 'url', url: 'http://127.0.0.1/health' }, neverSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/SSRF/);
  });

  it('passes public URLs through', async () => {
    mockCheckEgress.mockResolvedValue({ allowed: true });
    const result = await waitForHandler({ type: 'url', url: 'https://example.com/health' }, neverSignal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/succeeded/);
  });
});

describe('waitForHandler — success outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEgress.mockResolvedValue({ allowed: true });
  });

  it('url type succeeds and includes elapsed + attempts', async () => {
    const result = await waitForHandler({ type: 'url', url: 'https://example.com' }, neverSignal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('succeeded');
    expect(result.content).toMatch(/\d+ms/);
    expect(result.content).toMatch(/\d+ attempt/);
  });

  it('file type succeeds', async () => {
    const result = await waitForHandler({ type: 'file', path: '/tmp/test.txt' }, neverSignal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('succeeded');
  });

  it('process type succeeds', async () => {
    const result = await waitForHandler({ type: 'process', pid: 12345 }, neverSignal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('succeeded');
  });

  it('command type succeeds', async () => {
    const result = await waitForHandler({ type: 'command', command: 'true' }, neverSignal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('succeeded');
  });
});

describe('waitForHandler — timeout outcome', () => {
  it('timed_out is NOT an error', async () => {
    // Override evaluateFile to always return not met.
    const { evaluateFile } = await import('./wait-for-conditions.js');
    vi.mocked(evaluateFile).mockResolvedValue({ met: false, detail: 'file not found: /tmp/x' });
    const result = await waitForHandler(
      { type: 'file', path: '/tmp/x', timeout_ms: 0 },
      neverSignal,
    );
    // timeout_ms:0 means deadline is already passed on first miss
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('timed_out');
  });
});

describe('waitForHandler — cancelled outcome', () => {
  it('cancelled when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await waitForHandler({ type: 'command', command: 'true' }, ac.signal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('cancelled');
  });
});

// ---------------------------------------------------------------------------
// P4: body_contains → GET default
// ---------------------------------------------------------------------------

describe('waitForHandler — body_contains defaults method to GET', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEgress.mockResolvedValue({ allowed: true });
  });

  it('uses GET when body_contains is set and method is not explicit', async () => {
    const { evaluateUrl } = await import('./wait-for-conditions.js');
    const mockEvalUrl = vi.mocked(evaluateUrl);
    // Capture the condition passed to evaluateUrl
    let capturedCond: unknown;
    mockEvalUrl.mockImplementationOnce((cond, _sig) => {
      capturedCond = cond;
      return Promise.resolve({ met: true, detail: 'HTTP 200' });
    });

    await waitForHandler(
      { type: 'url', url: 'https://example.com', body_contains: 'ready' },
      neverSignal,
    );

    expect((capturedCond as { method?: string })?.method).toBe('GET');
  });

  it('respects explicit HEAD when body_contains is set', async () => {
    // This is an edge case — the user explicitly opted into HEAD even with
    // body_contains; the handler honours the explicit method.
    const result = await waitForHandler(
      { type: 'url', url: 'https://example.com', method: 'HEAD', body_contains: 'ready' },
      neverSignal,
    );
    // Validation passes (no error about method).
    // The mock evaluator resolves to met:true regardless.
    expect(result.isError).toBeFalsy();
  });

  it('uses HEAD by default when body_contains is not set', async () => {
    const { evaluateUrl } = await import('./wait-for-conditions.js');
    const mockEvalUrl = vi.mocked(evaluateUrl);
    let capturedCond: unknown;
    mockEvalUrl.mockImplementationOnce((cond, _sig) => {
      capturedCond = cond;
      return Promise.resolve({ met: true, detail: 'HTTP 200' });
    });

    await waitForHandler({ type: 'url', url: 'https://example.com' }, neverSignal);
    expect((capturedCond as { method?: string })?.method).toBe('HEAD');
  });
});

// ---------------------------------------------------------------------------
// #1430: PID registry wiring through the handler context
// ---------------------------------------------------------------------------

describe('waitForHandler — #1430 PID registry wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEgress.mockResolvedValue({ allowed: true });
  });

  it('passes context.spawnedPidRegistry to evaluateProcess', async () => {
    const { evaluateProcess } = await import('./wait-for-conditions.js');
    const mockEvalProcess = vi.mocked(evaluateProcess);
    let capturedRegistry: unknown;
    mockEvalProcess.mockImplementationOnce((_cond, registry) => {
      capturedRegistry = registry;
      return { met: true, detail: 'pid 12345 has exited' };
    });

    const fakeRegistry = { has: () => true, register: () => undefined, clear: () => undefined, size: 1 };
    await waitForHandler(
      { type: 'process', pid: 12345 },
      neverSignal,
      { spawnedPidRegistry: fakeRegistry } as never,
    );

    expect(capturedRegistry).toBe(fakeRegistry);
  });

  it('passes undefined registry when context has none', async () => {
    const { evaluateProcess } = await import('./wait-for-conditions.js');
    const mockEvalProcess = vi.mocked(evaluateProcess);
    let registryArg: unknown = 'NOT_SET';
    mockEvalProcess.mockImplementationOnce((_cond, registry) => {
      registryArg = registry;
      return { met: true, detail: 'pid 12345 has exited' };
    });

    await waitForHandler({ type: 'process', pid: 12345 }, neverSignal); // no context
    expect(registryArg).toBeUndefined();
  });

  it('registry-blocked result (met:false, blocked:true) still produces a non-error summary', async () => {
    // The handler should NOT surface blocked:true as isError — it returns the
    // poll summary (succeeded / timed_out). A registry rejection is a met:false
    // on each poll, and the test lets it time out at timeout_ms:0.
    const { evaluateProcess } = await import('./wait-for-conditions.js');
    vi.mocked(evaluateProcess).mockReturnValue({
      met: false,
      detail: 'pid 12345 is not a session-owned process (not in spawned PID registry)',
      data: { pid: 12345, blocked: true },
    });

    const result = await waitForHandler(
      { type: 'process', pid: 12345, timeout_ms: 0 } as never,
      neverSignal,
    );
    // timeout_ms:0 → timed_out verdict, which is NOT an error
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('timed_out');
  });
});

// ---------------------------------------------------------------------------
// P5: relative file path → resolved against context.cwd / resolveBase
// ---------------------------------------------------------------------------

describe('waitForHandler — relative path resolution for file type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEgress.mockResolvedValue({ allowed: true });
  });

  it('resolves a relative path against context.cwd', async () => {
    const { evaluateFile } = await import('./wait-for-conditions.js');
    const mockEvalFile = vi.mocked(evaluateFile);
    let capturedCond: unknown;
    mockEvalFile.mockImplementationOnce((cond) => {
      capturedCond = cond;
      return Promise.resolve({ met: true, detail: 'file exists (0 bytes)' });
    });

    await waitForHandler(
      { type: 'file', path: 'dist/server.js' },
      neverSignal,
      { cwd: '/home/user/myproject', resolveBase: undefined } as never,
    );

    expect((capturedCond as { path: string })?.path).toBe('/home/user/myproject/dist/server.js');
  });

  it('prefers context.resolveBase over context.cwd', async () => {
    const { evaluateFile } = await import('./wait-for-conditions.js');
    const mockEvalFile = vi.mocked(evaluateFile);
    let capturedCond: unknown;
    mockEvalFile.mockImplementationOnce((cond) => {
      capturedCond = cond;
      return Promise.resolve({ met: true, detail: 'file exists (0 bytes)' });
    });

    await waitForHandler(
      { type: 'file', path: 'dist/server.js' },
      neverSignal,
      { cwd: '/home/user/myproject', resolveBase: '/home/user/myproject/packages/app' } as never,
    );

    expect((capturedCond as { path: string })?.path).toBe(
      '/home/user/myproject/packages/app/dist/server.js',
    );
  });

  it('passes absolute paths through unchanged', async () => {
    const { evaluateFile } = await import('./wait-for-conditions.js');
    const mockEvalFile = vi.mocked(evaluateFile);
    let capturedCond: unknown;
    mockEvalFile.mockImplementationOnce((cond) => {
      capturedCond = cond;
      return Promise.resolve({ met: true, detail: 'file exists (0 bytes)' });
    });

    await waitForHandler(
      { type: 'file', path: '/absolute/path/to/file.txt' },
      neverSignal,
      { cwd: '/home/user/myproject' } as never,
    );

    expect((capturedCond as { path: string })?.path).toBe('/absolute/path/to/file.txt');
  });
});
