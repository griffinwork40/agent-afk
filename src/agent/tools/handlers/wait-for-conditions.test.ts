/**
 * Tests for wait-for-conditions.ts evaluators.
 *
 * Each evaluator is tested in isolation. Fetch is mocked via vi.stubGlobal;
 * fs is mocked via vi.mock; process.kill is restored after each test.
 *
 * @module agent/tools/handlers/wait-for-conditions.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the egress guard so tests don't hit DNS.
// ---------------------------------------------------------------------------
vi.mock('../../../web/egress-guard.js', () => ({
  checkEgressTarget: vi.fn().mockResolvedValue({ allowed: true }),
  assertEgressAllowed: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock fs/promises
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock child_process.execSync
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { evaluateUrl, evaluateFile, evaluateProcess, evaluateCommand } from './wait-for-conditions.js';
import { checkEgressTarget } from '../../../web/egress-guard.js';
import * as fsPromises from 'node:fs/promises';
import { execSync } from 'node:child_process';

const mockCheckEgress = vi.mocked(checkEgressTarget);
const mockStat = vi.mocked(fsPromises.stat);
const mockReadFile = vi.mocked(fsPromises.readFile);
const mockExecSync = vi.mocked(execSync);

// A never-aborting signal for tests that don't test cancellation.
const neverSignal = new AbortController().signal;

// ---------------------------------------------------------------------------
// evaluateUrl
// ---------------------------------------------------------------------------

describe('evaluateUrl', () => {
  beforeEach(() => {
    mockCheckEgress.mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns met:true on HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    }));
    const result = await evaluateUrl({ type: 'url', url: 'https://example.com' }, neverSignal);
    expect(result.met).toBe(true);
    expect(result.detail).toContain('200');
    vi.unstubAllGlobals();
  });

  it('returns met:false on HTTP 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 503,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    }));
    const result = await evaluateUrl({ type: 'url', url: 'https://example.com' }, neverSignal);
    expect(result.met).toBe(false);
    expect(result.data?.status).toBe(503);
    vi.unstubAllGlobals();
  });

  it('respects expected_status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 201,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    }));
    const result = await evaluateUrl(
      { type: 'url', url: 'https://example.com', expected_status: 200 },
      neverSignal,
    );
    expect(result.met).toBe(false);
    vi.unstubAllGlobals();
  });

  it('checks body_contains when present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: vi.fn().mockResolvedValue('Hello world'),
      body: { cancel: vi.fn() },
    }));
    const hit = await evaluateUrl(
      { type: 'url', url: 'https://example.com', method: 'GET', body_contains: 'world' },
      neverSignal,
    );
    expect(hit.met).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: vi.fn().mockResolvedValue('Hello world'),
      body: { cancel: vi.fn() },
    }));
    const miss = await evaluateUrl(
      { type: 'url', url: 'https://example.com', method: 'GET', body_contains: 'goodbye' },
      neverSignal,
    );
    expect(miss.met).toBe(false);
    vi.unstubAllGlobals();
  });

  it('returns met:false and blocked detail when SSRF guard blocks', async () => {
    mockCheckEgress.mockResolvedValueOnce({ allowed: false, reason: 'private IP' });
    const result = await evaluateUrl({ type: 'url', url: 'http://127.0.0.1' }, neverSignal);
    expect(result.met).toBe(false);
    expect(result.detail).toContain('SSRF blocked');
    expect(result.data?.blocked).toBe(true);
  });

  it('returns met:false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await evaluateUrl({ type: 'url', url: 'https://example.com' }, neverSignal);
    expect(result.met).toBe(false);
    expect(result.detail).toContain('fetch error');
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// evaluateFile
// ---------------------------------------------------------------------------

describe('evaluateFile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns met:true when file exists', async () => {
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 42 } as ReturnType<typeof fsPromises.stat> extends Promise<infer T> ? T : never);
    const result = await evaluateFile({ type: 'file', path: '/tmp/myfile.txt' });
    expect(result.met).toBe(true);
    expect(result.detail).toContain('42 bytes');
  });

  it('returns met:false when file is missing', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await evaluateFile({ type: 'file', path: '/tmp/missing.txt' });
    expect(result.met).toBe(false);
    expect(result.detail).toContain('not found');
  });

  it('checks content_contains when provided', async () => {
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 20 } as ReturnType<typeof fsPromises.stat> extends Promise<infer T> ? T : never);
    mockReadFile.mockResolvedValue('hello world' as unknown as Buffer);
    const hit = await evaluateFile({
      type: 'file',
      path: '/tmp/myfile.txt',
      content_contains: 'world',
    });
    expect(hit.met).toBe(true);

    mockReadFile.mockResolvedValue('hello world' as unknown as Buffer);
    const miss = await evaluateFile({
      type: 'file',
      path: '/tmp/myfile.txt',
      content_contains: 'goodbye',
    });
    expect(miss.met).toBe(false);
    expect(miss.detail).toContain('does not contain');
  });
});

// ---------------------------------------------------------------------------
// evaluateProcess
// ---------------------------------------------------------------------------

describe('evaluateProcess', () => {
  it('returns met:false when PID is still alive', () => {
    const spy = vi.spyOn(process, 'kill').mockReturnValue(true as unknown as boolean);
    const result = evaluateProcess({ type: 'process', pid: 12345 });
    expect(result.met).toBe(false);
    expect(result.detail).toContain('alive');
    spy.mockRestore();
  });

  it('returns met:true when PID has exited (ESRCH)', () => {
    const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => { throw err; });
    const result = evaluateProcess({ type: 'process', pid: 99999 });
    expect(result.met).toBe(true);
    expect(result.detail).toContain('exited');
    spy.mockRestore();
  });

  it('returns met:false on EPERM (process exists but no permission)', () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => { throw err; });
    const result = evaluateProcess({ type: 'process', pid: 1 });
    expect(result.met).toBe(false);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// evaluateCommand
// ---------------------------------------------------------------------------

describe('evaluateCommand', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns met:true when command exits 0', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    const result = evaluateCommand({ type: 'command', command: 'true' });
    expect(result.met).toBe(true);
    expect(result.detail).toContain('exited 0');
  });

  it('returns met:false when command exits non-zero', () => {
    mockExecSync.mockImplementation(() => {
      throw Object.assign(new Error('exit 1'), { status: 1 });
    });
    const result = evaluateCommand({ type: 'command', command: 'false' });
    expect(result.met).toBe(false);
    expect(result.detail).toContain('exited 1');
  });
});
