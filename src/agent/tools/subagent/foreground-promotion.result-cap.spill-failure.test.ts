/**
 * Tests for the spill-failure path in capSubagentResult.
 *
 * Isolated from foreground-promotion.result-cap.test.ts because vi.mock('node:fs', ...)
 * is hoisted to module scope and replaces writeFileSync for the entire module graph
 * of this file. Putting it in the main test file would break the 8 existing tests
 * that rely on real disk writes and assert sidecar files exist.
 *
 * Covered branch:
 *   spillSubagentOutput catch block → returns undefined → capSubagentResult
 *   uses the no-file-pointer fallback message ('could not be written to disk').
 *
 * @module agent/tools/subagent/foreground-promotion.result-cap.spill-failure.test
 */
import { describe, it, expect, vi } from 'vitest';
import { capSubagentResult } from './foreground-promotion.result-cap.js';

// ---------------------------------------------------------------------------
// Mock strategy:
//
//   vi.mock('node:fs', ...) is hoisted above imports by vitest so it is in
//   place when foreground-promotion.result-cap.ts is first imported. We
//   spread the original module and override only writeFileSync with a
//   controlled fake that unconditionally throws ENOSPC (disk full), which
//   exercises the catch block in spillSubagentOutput. mkdirSync is left real
//   so it can create the directory before the write fails — matching the
//   production failure mode where the directory exists but the disk is full.
// ---------------------------------------------------------------------------
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    writeFileSync: (..._args: Parameters<typeof original.writeFileSync>): void => {
      const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    },
  };
});

// Point getSessionsDir at a temp path (same as the main test file).
vi.mock('../../../paths.js', () => ({
  getSessionsDir: () => '/tmp/afk-test-result-cap-spill-failure',
}));

// Default env (undefined = 32KB default cap).
vi.mock('../../../config/env.js', () => ({
  env: new Proxy({} as Record<string, string | undefined>, {
    get: () => undefined,
  }),
}));

describe('capSubagentResult — spill failure', () => {
  it('returns capped:true with no-file-pointer message when writeFileSync throws', () => {
    // 40KB exceeds the 32KB default cap, so spill is attempted.
    const content = 'x'.repeat(40_000);
    const result = capSubagentResult(content, 'sess-spill-fail', 'sub-spill-fail');

    // Still capped — truncation happened regardless of spill success.
    expect(result.capped).toBe(true);

    // Falls back to the no-file-pointer message.
    expect(result.content).toContain('could not be written to disk');

    // No file path appears — spill failed so there is nothing to read_file.
    expect(result.content).not.toContain('subagent-handoffs');
    expect(result.content).not.toContain('read_file');

    // The byte count is still reported correctly.
    expect(result.content).toContain('40000 bytes');
  });
});
