/**
 * Unit tests for the git-helper internals of memory-loader:
 *   - getCurrentBranch(cwd?)
 *   - getRecentlyModifiedFiles(cwd?)
 *
 * Both functions call execFileSync internally. We mock the entire
 * `child_process` module so the tests run hermetically with no live git
 * state and no network access.
 *
 * @module agent/memory/memory-loader.git-helpers.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test.
// vi.hoisted ensures the mock reference is stable across Vitest's hoist
// boundary so the factory closure captures the same fn that tests mutate.
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, execFileSync: mockExecFileSync };
});

// Import after mock registration.
import {
  getCurrentBranch,
  getRecentlyModifiedFiles,
} from './memory-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute path that passes validateCwd (must be absolute). */
const FAKE_CWD = resolve('/fake/repo');

/** Make execFileSync return a Buffer-like object with toString(). */
function mockOutput(text: string) {
  return Buffer.from(text);
}

beforeEach(() => {
  mockExecFileSync.mockReset();
});

// ---------------------------------------------------------------------------
// getCurrentBranch
// ---------------------------------------------------------------------------

describe('getCurrentBranch', () => {
  it('returns the branch name when git succeeds', () => {
    mockExecFileSync.mockReturnValue(mockOutput('feat/my-feature\n'));

    const branch = getCurrentBranch(FAKE_CWD);

    expect(branch).toBe('feat/my-feature');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({ cwd: FAKE_CWD }),
    );
  });

  it('returns null when git outputs "HEAD" (detached HEAD state)', () => {
    mockExecFileSync.mockReturnValue(mockOutput('HEAD\n'));

    expect(getCurrentBranch(FAKE_CWD)).toBeNull();
  });

  it('returns null when git outputs an empty string', () => {
    mockExecFileSync.mockReturnValue(mockOutput('\n'));

    expect(getCurrentBranch(FAKE_CWD)).toBeNull();
  });

  it('returns null when execFileSync throws (not a git repo)', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    expect(getCurrentBranch(FAKE_CWD)).toBeNull();
  });

  it('trims surrounding whitespace from the branch name', () => {
    mockExecFileSync.mockReturnValue(mockOutput('  main  \n'));

    expect(getCurrentBranch(FAKE_CWD)).toBe('main');
  });

  it('returns null when cwd is a relative path (validateCwd throws but is caught)', () => {
    // validateCwd throws for relative paths, but getCurrentBranch wraps
    // execFileSync in a try/catch that swallows all errors — including the
    // validateCwd throw — and returns null.
    expect(getCurrentBranch('relative/path')).toBeNull();
  });

  it('returns the branch name when called with no cwd argument', () => {
    // process.cwd() is always absolute so validateCwd accepts it.
    mockExecFileSync.mockReturnValue(mockOutput('main\n'));

    const branch = getCurrentBranch();

    expect(branch).toBe('main');
    // Finding 3: include cwd in the matcher so a regression that drops it
    // is caught. No-cwd path uses process.cwd() which is always a string.
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({
        cwd: expect.any(String),
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3_000,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// getRecentlyModifiedFiles
// ---------------------------------------------------------------------------

describe('getRecentlyModifiedFiles', () => {
  /**
   * Default mock setup: origin/HEAD resolves to origin/main, then diff returns
   * two files. Each test can override specific calls via mockExecFileSync.
   */
  function setupHappyPath(base = 'origin/main', files = 'src/foo.ts\nsrc/bar.ts\n') {
    mockExecFileSync
      // Call 1: rev-parse --abbrev-ref origin/HEAD
      .mockReturnValueOnce(mockOutput(`${base}\n`))
      // Call 2: diff --name-only <base>
      .mockReturnValueOnce(mockOutput(files));
  }

  it('returns relative-path list when origin/HEAD is configured', () => {
    setupHappyPath('origin/main', 'src/foo.ts\nsrc/bar.ts\n');

    const files = getRecentlyModifiedFiles(FAKE_CWD);

    expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
    // Last call must be the git diff --name-only
    const lastCall = mockExecFileSync.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe('git');
    expect(lastCall[1]).toContain('--name-only');
    // Finding 1: use objectContaining instead of raw `as`-cast assertions.
    expect(lastCall[2]).toEqual(expect.objectContaining({
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  });

  it('uses origin/main as the diff base when origin/HEAD resolves to it', () => {
    setupHappyPath('origin/main', 'pkg/index.ts\n');

    const files = getRecentlyModifiedFiles(FAKE_CWD);

    expect(files).toContain('pkg/index.ts');
    const diffCall = mockExecFileSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('--name-only'),
    )!;
    expect(diffCall[1]).toContain('origin/main');
  });

  it('falls back to origin/master when origin/HEAD throws and origin/master exists', () => {
    mockExecFileSync
      // Call 0: rev-parse origin/HEAD → throws
      .mockImplementationOnce(() => { throw new Error('origin/HEAD not set'); })
      // Call 1: rev-parse --verify origin/master → succeeds (branch exists)
      .mockReturnValueOnce(mockOutput('abc123\n'))
      // Call 2: diff --name-only origin/master
      .mockReturnValueOnce(mockOutput('src/legacy.ts\n'));

    const files = getRecentlyModifiedFiles(FAKE_CWD);

    expect(files).toEqual(['src/legacy.ts']);
    const diffCall = mockExecFileSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('--name-only'),
    )!;
    expect(diffCall[1]).toContain('origin/master');
    // Finding 4: pin the timeout used for the origin/master verify call (index 1).
    // Production uses timeout: 2_000 — distinct from the 3_000/5_000 values on
    // the other calls. Pinning here ensures a regression is caught.
    expect(mockExecFileSync.mock.calls[1]![2]).toEqual(expect.objectContaining({
      timeout: 2_000,
    }));
  });

  it('falls back to origin/main when both origin/HEAD and origin/master fail', () => {
    mockExecFileSync
      // Call 1: rev-parse origin/HEAD → throws
      .mockImplementationOnce(() => { throw new Error('origin/HEAD not set'); })
      // Call 2: rev-parse --verify origin/master → throws (branch absent)
      .mockImplementationOnce(() => { throw new Error('origin/master not found'); })
      // Call 3: diff --name-only origin/main (the ultimate fallback)
      .mockReturnValueOnce(mockOutput('src/fallback.ts\n'));

    const files = getRecentlyModifiedFiles(FAKE_CWD);

    expect(files).toEqual(['src/fallback.ts']);
    const diffCall = mockExecFileSync.mock.calls.at(-1)!;
    expect(diffCall[1]).toContain('origin/main');
  });

  it('skips origin/HEAD when it resolves to the literal string "origin/HEAD"', () => {
    // When origin/HEAD is not configured, git rev-parse returns the literal
    // string "origin/HEAD". The helper detects this sentinel and keeps `base`
    // as 'origin/main' (the final fallback), skipping the master probe entirely.
    // So only 2 execFileSync calls happen: the origin/HEAD check + the diff.
    mockExecFileSync
      // Call 1: rev-parse origin/HEAD → literal "origin/HEAD" (not configured)
      .mockReturnValueOnce(mockOutput('origin/HEAD\n'))
      // Call 2: diff --name-only origin/main (no master probe — sentinel skips it)
      .mockReturnValueOnce(mockOutput('src/skipped-head.ts\n'));

    const files = getRecentlyModifiedFiles(FAKE_CWD);

    // Should have used origin/main (the ultimate fallback) for the diff.
    expect(files).toEqual(['src/skipped-head.ts']);
    const diffCall = mockExecFileSync.mock.calls.at(-1)!;
    expect(diffCall[1]).toContain('origin/main');
    // Finding 2: pin that only 2 calls happened (no spurious master probe).
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when git diff throws', () => {
    mockExecFileSync
      .mockReturnValueOnce(mockOutput('origin/main\n')) // origin/HEAD resolves
      .mockImplementationOnce(() => { throw new Error('git diff failed'); }); // diff throws

    expect(getRecentlyModifiedFiles(FAKE_CWD)).toEqual([]);
  });

  it('filters out empty lines from diff output', () => {
    mockExecFileSync
      .mockReturnValueOnce(mockOutput('origin/main\n'))
      .mockReturnValueOnce(mockOutput('\nsrc/a.ts\n\nsrc/b.ts\n\n'));

    const files = getRecentlyModifiedFiles(FAKE_CWD);

    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns empty array when no files are modified', () => {
    mockExecFileSync
      .mockReturnValueOnce(mockOutput('origin/main\n'))
      .mockReturnValueOnce(mockOutput('\n'));

    expect(getRecentlyModifiedFiles(FAKE_CWD)).toEqual([]);
  });

  it('returns empty array when cwd is a relative path (validateCwd throws but is caught)', () => {
    // validateCwd throws for relative paths, but getRecentlyModifiedFiles
    // wraps everything in a try/catch that returns [] on any error.
    expect(getRecentlyModifiedFiles('relative/path')).toEqual([]);
  });

  it('passes --no-optional-locks to every git call', () => {
    setupHappyPath('origin/main', 'src/x.ts\n');

    getRecentlyModifiedFiles(FAKE_CWD);

    for (const call of mockExecFileSync.mock.calls) {
      if (call[0] === 'git') {
        expect(call[1]).toContain('--no-optional-locks');
      }
    }
  });

  it('passes timeout and stdio to every git call', () => {
    // Finding 2: pin exact per-call production timeout values by mock-call
    // index so a regression swapping e.g. 3_000→1 is caught.
    // Call 0: rev-parse --abbrev-ref origin/HEAD → timeout: 3_000
    // Call 1: diff --name-only origin/main      → timeout: 5_000
    setupHappyPath('origin/main', 'src/x.ts\n');

    getRecentlyModifiedFiles(FAKE_CWD);

    expect(mockExecFileSync.mock.calls).toHaveLength(2);

    const [revParseCall, diffCall] = mockExecFileSync.mock.calls as [unknown[], unknown[]];
    expect(revParseCall[2]).toEqual(expect.objectContaining({
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }));
    expect(diffCall[2]).toEqual(expect.objectContaining({
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }));
  });

  it('uses process.cwd() implicitly when no cwd is provided', () => {
    // No cwd argument → validateCwd defaults to process.cwd() which is absolute.
    mockExecFileSync
      .mockReturnValueOnce(mockOutput('origin/main\n'))
      .mockReturnValueOnce(mockOutput(''));

    // Should not throw — process.cwd() is always absolute.
    expect(() => getRecentlyModifiedFiles()).not.toThrow();
  });

  it('passes the resolved cwd to execFileSync options', () => {
    setupHappyPath('origin/main', 'src/foo.ts\n');

    getRecentlyModifiedFiles(FAKE_CWD);

    for (const call of mockExecFileSync.mock.calls) {
      if (call[0] === 'git') {
        expect((call[2] as { cwd: string }).cwd).toBe(FAKE_CWD);
      }
    }
  });
});
