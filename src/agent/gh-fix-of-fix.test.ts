/**
 * Tests for src/agent/gh-fix-of-fix.ts
 *
 * All tests inject `execFn` — no real `gh` invocations occur.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  extractReferencedPrNumbers,
  getPrMergedAt,
  isMergedWithinDays,
  detectAndLabelFixOfFix,
  FIX_OF_FIX_WINDOW_DAYS,
  FIX_OF_FIX_LABEL,
} from './gh-fix-of-fix.js';

// ---------------------------------------------------------------------------
// extractReferencedPrNumbers
// ---------------------------------------------------------------------------

describe('extractReferencedPrNumbers', () => {
  it('returns empty array for text with no references', () => {
    expect(extractReferencedPrNumbers('This PR adds a new feature.')).toEqual([]);
  });

  it('extracts bare #NNNN reference', () => {
    expect(extractReferencedPrNumbers('Fixes regression from #1670')).toContain(1670);
  });

  it('extracts fix(#NNNN) pattern', () => {
    expect(extractReferencedPrNumbers('fix(#2012): add detector')).toContain(2012);
  });

  it('extracts "regression from #N" pattern', () => {
    expect(extractReferencedPrNumbers('addresses regression from #1978 review feedback')).toContain(1978);
  });

  it('extracts "follow-up to #N" pattern', () => {
    expect(extractReferencedPrNumbers('follow-up to #500')).toContain(500);
  });

  it('extracts "follow up to #N" (no hyphen) pattern', () => {
    expect(extractReferencedPrNumbers('follow up to #501')).toContain(501);
  });

  it('extracts "addresses #N" pattern', () => {
    expect(extractReferencedPrNumbers('addresses #300 review')).toContain(300);
  });

  it('extracts "fixes #N" (close-keyword) pattern', () => {
    expect(extractReferencedPrNumbers('fixes #42')).toContain(42);
  });

  it('extracts "closes #N" (close-keyword) pattern', () => {
    expect(extractReferencedPrNumbers('closes #99')).toContain(99);
  });

  it('de-duplicates repeated references', () => {
    const result = extractReferencedPrNumbers('see #100 and also #100 again');
    expect(result.filter((n) => n === 100)).toHaveLength(1);
  });

  it('extracts multiple distinct references', () => {
    const result = extractReferencedPrNumbers(
      'Regression from #1670, addresses #1978 review feedback',
    );
    expect(result).toContain(1670);
    expect(result).toContain(1978);
  });

  it('handles real-world PR body excerpt', () => {
    const body = `
## Summary
- Fixes regression introduced in #1670
- Addresses #1978 review feedback

Closes #2000
`;
    const result = extractReferencedPrNumbers(body);
    expect(result).toContain(1670);
    expect(result).toContain(1978);
    expect(result).toContain(2000);
  });
});

// ---------------------------------------------------------------------------
// isMergedWithinDays
// ---------------------------------------------------------------------------

describe('isMergedWithinDays', () => {
  const now = new Date('2024-03-15T12:00:00Z');

  it('returns true for a PR merged 2 days ago (within 7-day window)', () => {
    expect(isMergedWithinDays('2024-03-13T12:00:00Z', FIX_OF_FIX_WINDOW_DAYS, now)).toBe(true);
  });

  it('returns true for a PR merged exactly 7 days ago', () => {
    expect(isMergedWithinDays('2024-03-08T12:00:00Z', FIX_OF_FIX_WINDOW_DAYS, now)).toBe(true);
  });

  it('returns false for a PR merged 8 days ago (outside window)', () => {
    expect(isMergedWithinDays('2024-03-07T12:00:00Z', FIX_OF_FIX_WINDOW_DAYS, now)).toBe(false);
  });

  it('returns false for an invalid date string', () => {
    expect(isMergedWithinDays('not-a-date', FIX_OF_FIX_WINDOW_DAYS, now)).toBe(false);
  });

  it('returns true for a PR merged 1 second ago', () => {
    expect(isMergedWithinDays('2024-03-15T11:59:59Z', FIX_OF_FIX_WINDOW_DAYS, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getPrMergedAt
// ---------------------------------------------------------------------------

describe('getPrMergedAt', () => {
  it('returns ISO timestamp when PR is merged', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '2024-03-13T12:00:00Z\n', stderr: '' });
    expect(await getPrMergedAt(1670, exec)).toBe('2024-03-13T12:00:00Z');
  });

  it('returns null when gh outputs "null" (PR not merged)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'null\n', stderr: '' });
    expect(await getPrMergedAt(1670, exec)).toBeNull();
  });

  it('returns null when gh outputs empty string', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '\n', stderr: '' });
    expect(await getPrMergedAt(1670, exec)).toBeNull();
  });

  it('returns null when gh fails (PR not found)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('pr not found'));
    expect(await getPrMergedAt(9999, exec)).toBeNull();
  });

  it('passes the correct gh pr view arguments', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '2024-01-01T00:00:00Z\n', stderr: '' });
    await getPrMergedAt(42, exec);
    expect(exec).toHaveBeenCalledWith('gh', [
      'pr',
      'view',
      '42',
      '--json',
      'mergedAt',
      '--jq',
      '.mergedAt',
    ]);
  });
});

// ---------------------------------------------------------------------------
// detectAndLabelFixOfFix
// ---------------------------------------------------------------------------

describe('detectAndLabelFixOfFix', () => {
  /** A fixed "now" for deterministic window checks */
  const NOW = new Date('2024-03-15T12:00:00Z');

  /** Merged 2 days ago — within the 7-day window */
  const RECENT_MERGED_AT = '2024-03-13T12:00:00Z';

  /** Merged 30 days ago — outside the 7-day window */
  const OLD_MERGED_AT = '2024-02-14T12:00:00Z';

  it('returns isFixOfFix: false when no references found', async () => {
    const exec = vi.fn();
    const result = await detectAndLabelFixOfFix(123, 'No PR refs here.', { execFn: exec, now: NOW });
    expect(result.isFixOfFix).toBe(false);
    expect(result.recentlyMergedRefs).toEqual([]);
    expect(result.allRefs).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns isFixOfFix: false when referenced PR was merged outside the window', async () => {
    // exec called for: gh pr view 1670 (mergedAt) → old date
    const exec = vi.fn().mockResolvedValue({ stdout: `${OLD_MERGED_AT}\n`, stderr: '' });
    const result = await detectAndLabelFixOfFix(200, 'Regression from #1670', {
      execFn: exec,
      now: NOW,
    });
    expect(result.isFixOfFix).toBe(false);
    expect(result.recentlyMergedRefs).toEqual([]);
    expect(result.allRefs).toContain(1670);
  });

  it('returns isFixOfFix: false when referenced PR is not merged', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'null\n', stderr: '' });
    const result = await detectAndLabelFixOfFix(200, 'see #1670', { execFn: exec, now: NOW });
    expect(result.isFixOfFix).toBe(false);
  });

  it('returns isFixOfFix: true and applies label when ref is recently merged', async () => {
    const exec = vi
      .fn()
      // gh pr view 1670 --json mergedAt
      .mockResolvedValueOnce({ stdout: `${RECENT_MERGED_AT}\n`, stderr: '' })
      // gh label list (ensureFixOfFixLabel check)
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      // gh label create
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      // gh pr edit --add-label
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await detectAndLabelFixOfFix(200, 'Regression from #1670', {
      execFn: exec,
      now: NOW,
    });

    expect(result.isFixOfFix).toBe(true);
    expect(result.recentlyMergedRefs).toContain(1670);
    expect(result.allRefs).toContain(1670);

    // Verify the label was applied
    const labelCall = exec.mock.calls.find(
      (c: string[]) => c[0] === 'gh' && c[1].includes('--add-label'),
    );
    expect(labelCall).toBeDefined();
    expect(labelCall[1]).toContain(FIX_OF_FIX_LABEL);
  });

  it('excludes the current PR number from candidate refs (self-reference guard)', async () => {
    // Body mentions #123 — the same PR being opened
    const exec = vi.fn();
    const result = await detectAndLabelFixOfFix(123, 'Closes #123', { execFn: exec, now: NOW });
    // No gh calls should have been made
    expect(exec).not.toHaveBeenCalled();
    expect(result.isFixOfFix).toBe(false);
  });

  it('never throws when gh fails during merge check', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await detectAndLabelFixOfFix(200, 'Regression from #1670', {
      execFn: exec,
      now: NOW,
    });
    expect(result.isFixOfFix).toBe(false);
  });

  it('handles multiple refs and returns all recently merged ones', async () => {
    const exec = vi
      .fn()
      // PR 1670: recently merged
      .mockResolvedValueOnce({ stdout: `${RECENT_MERGED_AT}\n`, stderr: '' })
      // PR 1978: old merged
      .mockResolvedValueOnce({ stdout: `${OLD_MERGED_AT}\n`, stderr: '' })
      // ensureFixOfFixLabel — gh label list
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      // ensureFixOfFixLabel — gh label create
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      // applyFixOfFixLabel — gh pr edit
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await detectAndLabelFixOfFix(
      200,
      'Regression from #1670, addresses #1978',
      { execFn: exec, now: NOW },
    );

    expect(result.isFixOfFix).toBe(true);
    expect(result.recentlyMergedRefs).toContain(1670);
    expect(result.recentlyMergedRefs).not.toContain(1978);
    expect(result.allRefs).toContain(1670);
    expect(result.allRefs).toContain(1978);
  });

  it('accepts a string PR number (URL-resolved from gh pr create)', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: `${RECENT_MERGED_AT}\n`, stderr: '' })
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await detectAndLabelFixOfFix('200', 'Regression from #1670', {
      execFn: exec,
      now: NOW,
    });
    expect(result.isFixOfFix).toBe(true);
  });

  it('self-reference guard works when currentPrNumber is a full GitHub URL', async () => {
    // `gh pr create --json url` returns a full URL like https://github.com/owner/repo/pull/200.
    // parseInt('https://…', 10) returns NaN, so the guard would fail to filter the self-ref.
    // Verify that a body containing only the URL-format PR number is correctly excluded.
    const exec = vi.fn();
    const result = await detectAndLabelFixOfFix(
      'https://github.com/owner/repo/pull/200',
      'Closes #200',
      { execFn: exec, now: NOW },
    );
    // The body references only #200, which is the current PR — should be excluded, no gh calls.
    expect(exec).not.toHaveBeenCalled();
    expect(result.isFixOfFix).toBe(false);
  });

  it('detects a fix-of-fix correctly when currentPrNumber is a URL and body refs another PR', async () => {
    const exec = vi
      .fn()
      // gh pr view 1670 --json mergedAt → recently merged
      .mockResolvedValueOnce({ stdout: `${RECENT_MERGED_AT}\n`, stderr: '' })
      // ensureFixOfFixLabel — gh label list
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      // ensureFixOfFixLabel — gh label create
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      // applyFixOfFixLabel — gh pr edit
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await detectAndLabelFixOfFix(
      'https://github.com/owner/repo/pull/200',
      'Regression from #1670',
      { execFn: exec, now: NOW },
    );
    expect(result.isFixOfFix).toBe(true);
    expect(result.recentlyMergedRefs).toContain(1670);
  });
});
