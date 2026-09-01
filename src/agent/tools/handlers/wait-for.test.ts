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
