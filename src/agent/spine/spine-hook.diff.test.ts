/**
 * Unit tests for spine-hook.diff.ts.
 *
 * Tests cover:
 *  A. SPINE.md and spine-pending.jsonl are filtered from the diff.
 *  B. Diff is fetched from the worktree's own root (show-toplevel), not the
 *     common-dir root.
 *  C. Duplicate-diff fingerprinting skips re-classification.
 *
 * All git shell calls and fs I/O are mocked.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mock child_process ────────────────────────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(''),
  };
});

// ── Mock node:fs for fingerprint I/O ─────────────────────────────────────────

const _mockFsStore: Record<string, string> = {};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(
      (path: import('node:fs').PathOrFileDescriptor, encoding?: unknown): string => {
        const key = String(path);
        if (key in _mockFsStore) return _mockFsStore[key]!;
        throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      },
    ),
    writeFileSync: vi.fn(
      (path: import('node:fs').PathOrFileDescriptor, data: string): void => {
        _mockFsStore[String(path)] = data;
      },
    ),
    mkdirSync: vi.fn(),
  };
});

// ── Import under test (after mocks) ──────────────────────────────────────────

import { getClassifiableDiff, isDuplicateDiff, persistDiffFingerprint } from './spine-hook.diff.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Configure execFileSync: show-toplevel returns `worktreeRoot`; diff returns `diffOutput`. */
async function setupGitMock(worktreeRoot: string, diffOutput: string) {
  const { execFileSync } = await import('node:child_process');
  vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
    const a = args as string[];
    if (a.includes('--show-toplevel')) return worktreeRoot;
    if (a.includes('diff')) return diffOutput;
    return '';
  });
}

// ── Tests: outcome A — SPINE.md filtering ────────────────────────────────────

describe('getClassifiableDiff — outcome A: SPINE.md filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(_mockFsStore).forEach((k) => { delete _mockFsStore[k]; });
  });

  it('returns skipped=true when diff contains only SPINE.md changes', async () => {
    await setupGitMock('/repo', [
      'diff --git a/SPINE.md b/SPINE.md',
      'index abc..def 100644',
      '--- a/SPINE.md',
      '+++ b/SPINE.md',
      '@@ -1 +1 @@',
      '-old line',
      '+new line',
    ].join('\n'));

    const result = getClassifiableDiff('/repo', '/repo');
    expect(result.skipped).toBe(true);
    expect(result.diff).toBe('');
  });

  it('returns skipped=true when diff contains only spine-pending.jsonl changes', async () => {
    await setupGitMock('/repo', [
      'diff --git a/spine-pending.jsonl b/spine-pending.jsonl',
      '+{"type":"weakens"}',
    ].join('\n'));

    const result = getClassifiableDiff('/repo', '/repo');
    expect(result.skipped).toBe(true);
  });

  it('strips SPINE.md hunks but keeps other changes', async () => {
    await setupGitMock('/repo', [
      'diff --git a/SPINE.md b/SPINE.md',
      '+## annotation',
      'diff --git a/src/foo.ts b/src/foo.ts',
      '+const x = 1;',
    ].join('\n'));

    const result = getClassifiableDiff('/repo', '/repo');
    expect(result.skipped).toBe(false);
    expect(result.diff).not.toContain('SPINE.md');
    expect(result.diff).toContain('src/foo.ts');
  });

  it('returns skipped=true for an empty git diff', async () => {
    await setupGitMock('/repo', '');

    const result = getClassifiableDiff('/repo', '/repo');
    expect(result.skipped).toBe(true);
  });

  it('returns a non-empty fingerprint for a non-SPINE diff', async () => {
    await setupGitMock('/repo', 'diff --git a/src/foo.ts b/src/foo.ts\n+const x = 1;\n');

    const result = getClassifiableDiff('/repo', '/repo');
    expect(result.skipped).toBe(false);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Tests: outcome B — worktree-aware diff root ───────────────────────────────

describe('getClassifiableDiff — outcome B: worktree-aware diff root', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(_mockFsStore).forEach((k) => { delete _mockFsStore[k]; });
  });

  it('uses show-toplevel (not git-common-dir) to resolve the diff root', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      // Contract: show-toplevel must be called, not --git-common-dir
      if (a.includes('--git-common-dir')) {
        throw new Error('spine-hook.diff must NOT use git-common-dir for the diff root');
      }
      if (a.includes('--show-toplevel')) return '/worktree/root';
      if (a.includes('diff')) return 'diff --git a/src/bar.ts b/src/bar.ts\n+x\n';
      return '';
    });

    const result = getClassifiableDiff('/worktree/root', '/worktree/root');
    expect(result.skipped).toBe(false);
  });

  it('passes the session cwd as the worktree root for the diff', async () => {
    const { execFileSync } = await import('node:child_process');
    const cwdsSeen: string[] = [];

    vi.mocked(execFileSync).mockImplementation((_cmd, args, opts) => {
      const a = args as string[];
      if (a.includes('--show-toplevel')) {
        cwdsSeen.push(String((opts as { cwd?: string })?.cwd ?? ''));
        return '/my-worktree';
      }
      if (a.includes('diff')) return 'diff --git a/src/x.ts b/src/x.ts\n+y\n';
      return '';
    });

    const SESSION_CWD = '/my-worktree/src';
    getClassifiableDiff(SESSION_CWD, SESSION_CWD);
    // The show-toplevel call must use the session cwd, not a hardcoded path
    expect(cwdsSeen.some((c) => c === SESSION_CWD)).toBe(true);
  });
});

// ── Tests: outcome C — duplicate-diff fingerprinting ─────────────────────────

describe('isDuplicateDiff / persistDiffFingerprint — outcome C: stale diff dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(_mockFsStore).forEach((k) => { delete _mockFsStore[k]; });
  });

  it('isDuplicateDiff returns false when no fingerprint is stored', () => {
    expect(isDuplicateDiff('abc123')).toBe(false);
  });

  it('isDuplicateDiff returns false when stored fingerprint differs', () => {
    persistDiffFingerprint('aabbcc');
    expect(isDuplicateDiff('112233')).toBe(false);
  });

  it('isDuplicateDiff returns true after persistDiffFingerprint stores the same hash', () => {
    const fp = 'deadbeef';
    persistDiffFingerprint(fp);
    expect(isDuplicateDiff(fp)).toBe(true);
  });

  it('getClassifiableDiff emits a stable fingerprint for the same diff content', async () => {
    await setupGitMock('/repo', 'diff --git a/src/foo.ts b/src/foo.ts\n+x\n');

    const r1 = getClassifiableDiff('/repo', '/repo');
    const r2 = getClassifiableDiff('/repo', '/repo');
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it('getClassifiableDiff emits different fingerprints for different diffs', async () => {
    const { execFileSync } = await import('node:child_process');

    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes('--show-toplevel')) return '/repo';
      return '';
    });

    // Diff A
    vi.mocked(execFileSync).mockImplementationOnce((_cmd, args) => {
      const a = args as string[];
      if (a.includes('--show-toplevel')) return '/repo';
      return '';
    });

    // Run with diff A
    const { execFileSync: efs } = await import('node:child_process');
    vi.mocked(efs).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes('--show-toplevel')) return '/repo';
      if (a.includes('diff')) return 'diff --git a/A.ts b/A.ts\n+x\n';
      return '';
    });
    const rA = getClassifiableDiff('/repo', '/repo');

    // Run with diff B
    vi.mocked(efs).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes('--show-toplevel')) return '/repo';
      if (a.includes('diff')) return 'diff --git a/B.ts b/B.ts\n+y\n';
      return '';
    });
    const rB = getClassifiableDiff('/repo', '/repo');

    expect(rA.fingerprint).not.toBe(rB.fingerprint);
  });
});

// ── Tests: outcome D — cross-annotation strip via stripStatusAnnotation ───────
// (Tested indirectly via getClassifiableDiff being exercised by the hook tests;
//  direct tests for the behaviour are in spine-hook.test.ts cross-annotation
//  describe block below.)
