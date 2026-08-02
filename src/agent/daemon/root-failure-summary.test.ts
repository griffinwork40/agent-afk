/**
 * The module had no test file at all (#771 review, F-T1), so its only
 * arithmetic — the truncation ceiling — was never exercised. These cases pin
 * both halves of its contract: basenames only, and a bounded length.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_ROOT_FAILURE_SUMMARY_CHARS,
  summarizeRootFailures,
} from './root-failure-summary.js';

describe('summarizeRootFailures', () => {
  it('renders the count and one basename-plus-reason per failure', () => {
    const line = summarizeRootFailures([
      { repoRoot: '/Users/someone/Projects/alpha', reason: 'not a git repository' },
      { repoRoot: '/Users/someone/Projects/beta', reason: 'permission denied' },
    ]);

    expect(line).toBe(
      '2 root(s) failed sweep — alpha: not a git repository; beta: permission denied',
    );
  });

  it('never leaks a directory above the repo basename', () => {
    // Invariant the module exists to enforce: errorMessage is written to a
    // world-readable JSONL and forwarded into a Telegram push, while the root
    // registry deliberately stores the same paths at 0o600.
    const line = summarizeRootFailures([
      { repoRoot: '/Users/someone/secret-client-work/repo', reason: 'boom' },
    ]);

    expect(line).toContain('repo: boom');
    expect(line).not.toContain('/Users/someone');
    expect(line).not.toContain('secret-client-work');
  });

  it('truncates to the ceiling with a trailing ellipsis', () => {
    // 64 failures is the MAX_ROOTS worst case: every registered root failing on
    // every tick for as long as the prune stays systemically broken.
    const failures = Array.from({ length: 64 }, (_, i) => ({
      repoRoot: `/Users/someone/Projects/repo-${String(i).padStart(3, '0')}`,
      reason: 'fatal: not a git repository (or any of the parent directories)',
    }));

    const line = summarizeRootFailures(failures);

    expect(line).toHaveLength(MAX_ROOT_FAILURE_SUMMARY_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });

  it('leaves a summary at exactly the ceiling untruncated', () => {
    // Boundary: `<=` keeps a full-length line intact, so the ellipsis appears
    // only once the join genuinely overflows.
    const prefix = '1 root(s) failed sweep — r: ';
    const reason = 'x'.repeat(MAX_ROOT_FAILURE_SUMMARY_CHARS - prefix.length);

    const line = summarizeRootFailures([{ repoRoot: '/tmp/r', reason }]);

    expect(line).toHaveLength(MAX_ROOT_FAILURE_SUMMARY_CHARS);
    expect(line.endsWith('…')).toBe(false);
  });

  it('handles the empty list without inventing a failure', () => {
    expect(summarizeRootFailures([])).toBe('0 root(s) failed sweep — ');
  });
});
