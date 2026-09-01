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
// Mock guardedFetch so tests don't hit DNS or real HTTP.
// ---------------------------------------------------------------------------
vi.mock('../../../web/egress-guard.js', () => ({
  guardedFetch: vi.fn(),
  checkEgressTarget: vi.fn().mockResolvedValue({ allowed: true }),
  assertEgressAllowed: vi.fn().mockResolvedValue(undefined),
  EgressBlockedError: class EgressBlockedError extends Error {
    constructor(msg: string) { super(msg); this.name = 'EgressBlockedError'; }
  },
}));

// ---------------------------------------------------------------------------
// Mock the risk classifier so command-gate tests are deterministic.
// ---------------------------------------------------------------------------
vi.mock('../../risk-classifier.js', () => ({
  classifyRisk: vi.fn().mockReturnValue('safe'),
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
import { guardedFetch, EgressBlockedError } from '../../../web/egress-guard.js';
import { classifyRisk } from '../../risk-classifier.js';
import * as fsPromises from 'node:fs/promises';
import { execSync } from 'node:child_process';

const mockGuardedFetch = vi.mocked(guardedFetch);
const mockClassifyRisk = vi.mocked(classifyRisk);
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
    vi.clearAllMocks();
    mockClassifyRisk.mockReturnValue('safe');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns met:true on HTTP 200 using guardedFetch', async () => {
    mockGuardedFetch.mockResolvedValue({
      status: 200,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Response);
    const result = await evaluateUrl({ type: 'url', url: 'https://example.com' }, neverSignal);
    expect(result.met).toBe(true);
    expect(result.detail).toContain('200');
    expect(mockGuardedFetch).toHaveBeenCalledWith(
      globalThis.fetch,
      'https://example.com',
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('returns met:false on HTTP 503', async () => {
    mockGuardedFetch.mockResolvedValue({
      status: 503,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Response);
    const result = await evaluateUrl({ type: 'url', url: 'https://example.com' }, neverSignal);
    expect(result.met).toBe(false);
    expect(result.data?.status).toBe(503);
  });

  it('respects expected_status', async () => {
    mockGuardedFetch.mockResolvedValue({
      status: 201,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Response);
    const result = await evaluateUrl(
      { type: 'url', url: 'https://example.com', expected_status: 200 },
      neverSignal,
    );
    expect(result.met).toBe(false);
  });

  it('checks body_contains when present', async () => {
    mockGuardedFetch.mockResolvedValue({
      status: 200,
      text: vi.fn().mockResolvedValue('Hello world'),
      body: { cancel: vi.fn() },
    } as unknown as Response);
    const hit = await evaluateUrl(
      { type: 'url', url: 'https://example.com', method: 'GET', body_contains: 'world' },
      neverSignal,
    );
    expect(hit.met).toBe(true);

    mockGuardedFetch.mockResolvedValue({
      status: 200,
      text: vi.fn().mockResolvedValue('Hello world'),
      body: { cancel: vi.fn() },
    } as unknown as Response);
    const miss = await evaluateUrl(
      { type: 'url', url: 'https://example.com', method: 'GET', body_contains: 'goodbye' },
      neverSignal,
    );
    expect(miss.met).toBe(false);
  });

  it('returns met:false and blocked detail when SSRF guard blocks via guardedFetch', async () => {
    // guardedFetch throws EgressBlockedError when a private target is detected
    // on any hop (including redirect chains). The evaluator converts this to a
    // structured "SSRF blocked:" detail so callers can pattern-match on it.
    mockGuardedFetch.mockRejectedValue(
      new EgressBlockedError('refusing to fetch — internal/private address 127.0.0.1'),
    );
    const result = await evaluateUrl({ type: 'url', url: 'http://127.0.0.1' }, neverSignal);
    expect(result.met).toBe(false);
    expect(result.detail).toContain('SSRF blocked');
    expect(result.data?.blocked).toBe(true);
  });

  it('returns met:false on network error', async () => {
    mockGuardedFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await evaluateUrl({ type: 'url', url: 'https://example.com' }, neverSignal);
    expect(result.met).toBe(false);
    expect(result.detail).toContain('fetch error');
  });

  it('passes signal through to guardedFetch', async () => {
    mockGuardedFetch.mockResolvedValue({
      status: 200,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Response);
    const ac = new AbortController();
    await evaluateUrl({ type: 'url', url: 'https://example.com' }, ac.signal);
    expect(mockGuardedFetch).toHaveBeenCalledWith(
      globalThis.fetch,
      'https://example.com',
      expect.objectContaining({ signal: ac.signal }),
    );
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
  beforeEach(() => {
    mockClassifyRisk.mockReturnValue('safe');
  });

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

  it('blocks high-risk commands before execSync is called', () => {
    // Simulate the classifier flagging a dangerous command (rm -rf, sudo, etc.)
    mockClassifyRisk.mockReturnValue('high');
    const result = evaluateCommand({ type: 'command', command: 'rm -rf /' });
    expect(result.met).toBe(false);
    expect(result.detail).toContain('blocked by risk classifier');
    expect(result.data?.blocked).toBe(true);
    // execSync must NOT have been called
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('classifies using the bash tool name so the same bash rule table applies', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    evaluateCommand({ type: 'command', command: 'echo hello', cwd: '/tmp' });
    expect(mockClassifyRisk).toHaveBeenCalledWith(
      'bash',
      { command: 'echo hello' },
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('passes medium-risk commands through to execSync', () => {
    mockClassifyRisk.mockReturnValue('medium');
    mockExecSync.mockReturnValue(Buffer.from(''));
    const result = evaluateCommand({ type: 'command', command: 'git status' });
    expect(mockExecSync).toHaveBeenCalledOnce();
    expect(result.met).toBe(true);
  });
});
