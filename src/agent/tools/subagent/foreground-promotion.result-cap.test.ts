/**
 * Unit tests for the subagent result size cap.
 *
 * Verifies: inline passthrough for small results, head+tail truncation with
 * sidecar spill for oversized results, env-tunable threshold, and the
 * disabled (0) path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { capSubagentResult } from './foreground-promotion.result-cap.js';

// Stable mock for getSessionsDir — points at a temp dir we control.
const TEST_SESSIONS_DIR = '/tmp/afk-test-result-cap-sessions';

vi.mock('../../../paths.js', () => ({
  getSessionsDir: () => TEST_SESSIONS_DIR,
}));

// Mock env to control AFK_SUBAGENT_RESULT_CAP_BYTES per test.
const mockEnv: Record<string, string | undefined> = {};
vi.mock('../../../config/env.js', () => ({
  env: new Proxy({} as Record<string, string | undefined>, {
    get: (_t, prop: string) => mockEnv[prop],
  }),
}));

// Controllable mock for writeFileSync. vi.hoisted() ensures the mock fn
// object is created before Vitest's vi.mock() hoisting runs the factory.
// The factory keeps all other fs exports real; only writeFileSync is replaced.
// Individual tests can call mockWriteFileSync.mockImplementation(() => { throw … })
// to exercise the spill-failure branch; beforeEach resets to the real impl.
const { mockWriteFileSync } = vi.hoisted(() => {
  const mockWriteFileSync = vi.fn<Parameters<typeof import('node:fs').writeFileSync>, void>();
  return { mockWriteFileSync };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: mockWriteFileSync,
  };
});

beforeEach(async () => {
  // Reset env mock to default (undefined = use 32KB default).
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  // Re-install the real writeFileSync so most tests write files normally.
  // We import the actual (un-mocked) implementation via importActual.
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockWriteFileSync.mockImplementation(actualFs.writeFileSync as any);
  // Clean up any spill files from prior runs.
  rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true });
  mockWriteFileSync.mockClear();
});

describe('capSubagentResult', () => {
  it('returns content unchanged when it fits within the default cap', () => {
    const content = 'Short subagent finding.';
    const result = capSubagentResult(content, 'sess-1', 'sub-1');
    expect(result.capped).toBe(false);
    expect(result.content).toBe(content);
  });

  it('caps and spills content that exceeds the default threshold', () => {
    // 40KB of content exceeds the 32KB default.
    const content = 'x'.repeat(40_000);
    const result = capSubagentResult(content, 'sess-2', 'sub-2');

    expect(result.capped).toBe(true);
    // The capped content should be smaller than the original.
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThan(
      Buffer.byteLength(content, 'utf8'),
    );
    // Should contain the file pointer.
    expect(result.content).toContain('subagent-handoffs/sub-2.txt');
    expect(result.content).toContain('read_file');
    expect(result.content).toContain('40000 bytes');

    // Verify the sidecar file was written with the full content.
    const spillPath = `${TEST_SESSIONS_DIR}/sess-2/subagent-handoffs/sub-2.txt`;
    expect(existsSync(spillPath)).toBe(true);
    expect(readFileSync(spillPath, 'utf8')).toBe(content);

    // Upper-bound: after Fix 2, pointer is reserved within the budget.
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(32_768);
  });

  it('respects a custom cap set via env var', () => {
    mockEnv['AFK_SUBAGENT_RESULT_CAP_BYTES'] = '1000';
    // 2KB content exceeds the 1KB custom cap.
    const content = 'y'.repeat(2000);
    const result = capSubagentResult(content, 'sess-3', 'sub-3');

    expect(result.capped).toBe(true);
    expect(result.content).toContain('subagent-handoffs/sub-3.txt');
  });

  it('disables the cap when env var is set to 0', () => {
    mockEnv['AFK_SUBAGENT_RESULT_CAP_BYTES'] = '0';
    const content = 'z'.repeat(100_000);
    const result = capSubagentResult(content, 'sess-4', 'sub-4');

    expect(result.capped).toBe(false);
    expect(result.content).toBe(content);
  });

  it('caps content even when sessionId is undefined (no spill, fallback message)', () => {
    const content = 'a'.repeat(40_000);
    const result = capSubagentResult(content, undefined, 'sub-5');

    // Fix 1: should still be capped even without a sessionId.
    expect(result.capped).toBe(true);
    expect(result.content).not.toBe(content);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThan(
      Buffer.byteLength(content, 'utf8'),
    );
    // Should use the no-spill fallback message (no file path).
    expect(result.content).toContain('could not be written to disk');
    // Should NOT contain a file path reference.
    expect(result.content).not.toContain('subagent-handoffs');
  });

  it('handles spill failure gracefully — capped:true and fallback pointer when writeFileSync throws', () => {
    // Make writeFileSync throw to simulate a disk-write failure.
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const content = 'b'.repeat(40_000);
    const result = capSubagentResult(content, 'sess-spill-fail', 'sub-spill-fail');

    // Even with a spill failure the content must still be capped.
    expect(result.capped).toBe(true);
    // The fallback pointer must be used — no file path in the message.
    expect(result.content).toContain('could not be written to disk');
    expect(result.content).not.toContain(TEST_SESSIONS_DIR);
  });

  it('falls back to default cap on unparseable env var', () => {
    mockEnv['AFK_SUBAGENT_RESULT_CAP_BYTES'] = 'not-a-number';
    const content = 'b'.repeat(40_000);
    const result = capSubagentResult(content, 'sess-6', 'sub-6');

    expect(result.capped).toBe(true);
  });

  it('preserves both head and tail in the truncated view', () => {
    const head = 'HEAD_MARKER_' + 'x'.repeat(20_000);
    const tail = 'y'.repeat(20_000) + '_TAIL_MARKER';
    const content = head + tail;
    const result = capSubagentResult(content, 'sess-7', 'sub-7');

    expect(result.capped).toBe(true);
    // headAndTail preserves both ends.
    expect(result.content).toContain('HEAD_MARKER_');
    expect(result.content).toContain('_TAIL_MARKER');
    // The elision marker from headAndTail should be present.
    expect(result.content).toContain('bytes truncated');
  });

  it('handles negative env var values by falling back to default', () => {
    mockEnv['AFK_SUBAGENT_RESULT_CAP_BYTES'] = '-1';
    const content = 'c'.repeat(40_000);
    const result = capSubagentResult(content, 'sess-8', 'sub-8');

    expect(result.capped).toBe(true);
  });
});
