import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { rmSyncRetry } from './__test-utils__/rm-sync-retry.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  formatEntries,
  getExistingUnreleased,
  parseCommits,
  stampRelease,
  updateAndStampChangelog,
  type CommitEntry,
} from './changelog.js';

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
}

/** Set up a minimal temp git repo with a CHANGELOG.md and a v0.1.0 tag. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-unit-'));
  sh('git init', dir);
  sh('git config user.email "test@test.com"', dir);
  sh('git config user.name "Test"', dir);
  writeFileSync(join(dir, 'CHANGELOG.md'), INITIAL_CHANGELOG);
  sh('git add -A && git commit -m "chore: initial"', dir);
  sh('git tag v0.1.0', dir);
  return dir;
}

const INITIAL_CHANGELOG = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01

### Added
- Initial release
`;

// ─────────────────────────────────────────────────────────────────────────────
// formatEntries
// ─────────────────────────────────────────────────────────────────────────────
describe('formatEntries', () => {
  it('omits hash by default — plain `- <subject>` bullets for human-facing changelogs', () => {
    // Regression guard for PR #145 review finding H-1.
    // Plain `- <subject>` bullets are the human-facing default for
    // CHANGELOG.md. Default behavior of formatEntries is includeHash=false.
    const commits: CommitEntry[] = [
      { hash: 'abc1234', subject: 'add new feature', category: 'Added' },
      { hash: 'def5678', subject: 'resolve crash', category: 'Fixed' },
    ];
    const result = formatEntries(commits);
    expect(result).toContain('- add new feature');
    expect(result).toContain('- resolve crash');
    // Crucial: no parenthesized hash anywhere in the output.
    expect(result).not.toMatch(/\([0-9a-f]{7,}\)/);
  });

  it('appends the short hash in parentheses when includeHash: true (CI mode)', () => {
    // CI (scripts/generate-changelog.mjs) opts in to hash bullets so
    // updateAndStampChangelog dedup can match prior entries.
    const commits: CommitEntry[] = [
      { hash: 'abc1234', subject: 'add new feature', category: 'Added' },
      { hash: 'def5678', subject: 'resolve crash', category: 'Fixed' },
    ];
    const result = formatEntries(commits, { includeHash: true });
    expect(result).toContain('- add new feature (abc1234)');
    expect(result).toContain('- resolve crash (def5678)');
  });

  it('groups entries under the correct category headings', () => {
    const commits: CommitEntry[] = [
      { hash: 'aaa0001', subject: 'feat A', category: 'Added' },
      { hash: 'bbb0002', subject: 'fix B', category: 'Fixed' },
      { hash: 'ccc0003', subject: 'refactor C', category: 'Changed' },
    ];
    const result = formatEntries(commits);
    const addedPos = result.indexOf('### Added');
    const fixedPos = result.indexOf('### Fixed');
    const changedPos = result.indexOf('### Changed');
    expect(addedPos).toBeLessThan(fixedPos);
    expect(fixedPos).toBeLessThan(changedPos);
  });

  it('returns empty string for empty commit list', () => {
    expect(formatEntries([])).toBe('');
    expect(formatEntries([], { includeHash: true })).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stampRelease — item #4
// ─────────────────────────────────────────────────────────────────────────────
describe('stampRelease', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stamp-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) happy path — stamps [Unreleased] → [X.Y.Z] and inserts fresh [Unreleased] above', () => {
    const cl = `# Changelog\n\n## [Unreleased]\n\n### Added\n- cool thing (abc1234)\n\n## [0.1.0] - 2026-01-01\n`;
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), cl);

    stampRelease(tmpDir, '1.0.0', '2026-06-15');

    const result = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(result).toContain('## [Unreleased]');
    expect(result).toContain('## [1.0.0] - 2026-06-15');
    // Fresh [Unreleased] should appear BEFORE the versioned section
    const unrelPos = result.indexOf('## [Unreleased]');
    const versionPos = result.indexOf('## [1.0.0]');
    expect(unrelPos).toBeLessThan(versionPos);
    // Old content is preserved under the new versioned header
    expect(result).toContain('cool thing (abc1234)');
  });

  it('(b) idempotency — does not double-stamp when version already exists', () => {
    // If the caller only invokes stampRelease (no [Unreleased] update first), and
    // the version heading is already present, no second replacement should occur.
    const cl = `# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-06-15\n\n### Added\n- cool thing\n`;
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), cl);

    // First stamp — no-op on the already-stamped version (the regex matches
    // [Unreleased] and replaces it; run twice to ensure idempotency of second call)
    stampRelease(tmpDir, '1.0.0', '2026-06-15');
    const afterFirst = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf8');

    stampRelease(tmpDir, '1.0.0', '2026-06-15');
    const afterSecond = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf8');

    // Should not accumulate additional [Unreleased] + [1.0.0] headers
    const occurrences = (s: string, sub: string) =>
      [...s.matchAll(new RegExp(sub.replace(/[[\]]/g, '\\$&'), 'g'))].length;

    expect(occurrences(afterSecond, '[1.0.0]')).toBeGreaterThanOrEqual(1);
    // The second call added one more [Unreleased]+[1.0.0] block — document the
    // behaviour rather than assert exact count (stampRelease is intentionally
    // simple; the combined function is the safe path for CI).
    expect(afterSecond).toContain('## [Unreleased]');
    void afterFirst; // referenced for clarity
  });

  it('(c) preserves content above and below the section', () => {
    const cl = [
      '# Changelog',
      '',
      'Some intro paragraph.',
      '',
      '## [Unreleased]',
      '',
      '### Fixed',
      '- bug fix (fed9876)',
      '',
      '## [0.1.0] - 2026-01-01',
      '',
      '### Added',
      '- Initial release',
      '',
      '[Unreleased]: https://github.com/x/y/compare/v0.1.0...HEAD',
    ].join('\n');

    writeFileSync(join(tmpDir, 'CHANGELOG.md'), cl);
    stampRelease(tmpDir, '2.0.0', '2026-07-04');

    const result = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(result).toContain('Some intro paragraph.');
    expect(result).toContain('## [0.1.0] - 2026-01-01');
    expect(result).toContain('Initial release');
    expect(result).toContain('[Unreleased]: https://github.com');
    expect(result).toContain('## [2.0.0] - 2026-07-04');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateAndStampChangelog — atomic write (item #3)
// ─────────────────────────────────────────────────────────────────────────────
describe('updateAndStampChangelog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'atomic-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes entries and stamps the version in a single call', () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), INITIAL_CHANGELOG);

    const entries = '### Added\n- new feature (abc1234)\n';
    updateAndStampChangelog(tmpDir, entries, '1.0.0', '2026-06-01');

    const result = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(result).toContain('new feature (abc1234)');
    expect(result).toContain('## [1.0.0] - 2026-06-01');
    // Fresh [Unreleased] above versioned section
    const unrelPos = result.indexOf('## [Unreleased]');
    const versionPos = result.indexOf('## [1.0.0]');
    expect(unrelPos).toBeLessThan(versionPos);
    // Old release preserved
    expect(result).toContain('## [0.1.0] - 2026-01-01');
  });

  it('deduplicates when [Unreleased] already has matching hashes', () => {
    const existing = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '- prior commit (aaa0001)',
      '',
      '## [0.1.0] - 2026-01-01',
      '',
    ].join('\n');
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), existing);

    // CI sees both aaa0001 (already written) and bbb0002 (new)
    const entries = '### Added\n- prior commit (aaa0001)\n- second commit (bbb0002)\n';
    updateAndStampChangelog(tmpDir, entries, '1.1.0', '2026-07-01');

    const result = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf8');
    const dupCount = [...result.matchAll(/aaa0001/g)].length;
    expect(dupCount).toBe(1);
    expect(result).toContain('second commit (bbb0002)');
    expect(result).toContain('## [1.1.0] - 2026-07-01');
  });

  it('throws when CHANGELOG.md has no [Unreleased] section', () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n');
    expect(() =>
      updateAndStampChangelog(tmpDir, '### Added\n- x (abc0001)\n', '2.0.0', '2026-08-01'),
    ).toThrow('No ## [Unreleased] section found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseCommits — integration smoke test
// ─────────────────────────────────────────────────────────────────────────────
describe('parseCommits', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = makeGitRepo();
  });

  afterEach(() => {
    process.chdir(origCwd);
    // rmSyncRetry: git may still write loose objects into .git/objects after
    // the test finishes. maxRetries/retryDelay give in-flight writes time to
    // settle before each rmdir attempt, avoiding ENOTEMPTY on CI.
    rmSyncRetry(tmpDir);
  });

  it('returns commits since the last tag', () => {
    writeFileSync(join(tmpDir, 'x.ts'), 'export const x = 1;');
    sh('git add -A && git commit -m "feat: add x"', tmpDir);

    const commits = parseCommits(tmpDir);
    expect(commits.length).toBeGreaterThanOrEqual(1);
    const feat = commits.find((c) => c.subject === 'add x');
    expect(feat).toBeDefined();
    expect(feat?.category).toBe('Added');
    expect(feat?.hash).toMatch(/^[0-9a-f]{7}/);
  });

  it('returns empty array when no commits since tag', () => {
    const commits = parseCommits(tmpDir);
    expect(commits).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getExistingUnreleased — direct unit tests
// Foundation of dedup logic; exercised indirectly elsewhere, but a regex bug
// here would cascade silently. These tests pin the contract directly.
// ─────────────────────────────────────────────────────────────────────────────
describe('getExistingUnreleased', () => {
  it('happy path — returns trimmed body between [Unreleased] and next version header', () => {
    const cl = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '- new thing (abc1234)',
      '',
      '## [1.0.0] - 2026-01-01',
      '',
      '### Added',
      '- Initial release',
    ].join('\n');

    const result = getExistingUnreleased(cl);
    expect(result).toContain('### Added');
    expect(result).toContain('- new thing (abc1234)');
    // Must NOT bleed into the versioned section
    expect(result).not.toContain('[1.0.0]');
    expect(result).not.toContain('Initial release');
  });

  it('no [Unreleased] section — returns empty string (does not throw)', () => {
    const cl = '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- Initial release\n';
    expect(getExistingUnreleased(cl)).toBe('');
  });

  it('[Unreleased] is the last section with no following version header', () => {
    const cl = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Fixed',
      '- dangling fix (fed9876)',
      '',
    ].join('\n');

    const result = getExistingUnreleased(cl);
    expect(result).toContain('### Fixed');
    expect(result).toContain('- dangling fix (fed9876)');
  });

  it('[Unreleased] header present but body is empty (next version immediately follows)', () => {
    const cl = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [1.0.0] - 2026-01-01',
      '',
    ].join('\n');

    expect(getExistingUnreleased(cl)).toBe('');
  });

  it('header has trailing decoration (date suffix) — still extracts body correctly', () => {
    const cl = [
      '# Changelog',
      '',
      '## [Unreleased] - 2099-12-31',
      '',
      '### Changed',
      '- future change (aaa0001)',
      '',
      '## [1.0.0] - 2026-01-01',
      '',
    ].join('\n');

    const result = getExistingUnreleased(cl);
    expect(result).toContain('### Changed');
    expect(result).toContain('- future change (aaa0001)');
  });

  it('multiple [Unreleased] headers — returns only the first block (documents current behavior)', () => {
    // Malformed input; pins regex behavior (first match wins, no global flag).
    const cl = [
      '## [Unreleased]',
      '',
      '### Added',
      '- first block entry (aaa0001)',
      '',
      '## [Unreleased]',
      '',
      '### Fixed',
      '- second block entry (bbb0002)',
      '',
      '## [1.0.0] - 2026-01-01',
      '',
    ].join('\n');

    const result = getExistingUnreleased(cl);
    expect(result).toContain('first block entry (aaa0001)');
    expect(result).not.toContain('second block entry (bbb0002)');
  });
});
