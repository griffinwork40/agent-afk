/**
 * Tests for src/agent/pr-review-label.ts
 *
 * All tests inject `execFn` — no real `gh` invocations occur.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  isBotLogin,
  classifyReviews,
  fetchPrReviews,
  ensureLabelExists,
  applyReviewLabel,
  labelPrReviewCoverage,
  LABEL_HUMAN_REVIEWED,
  LABEL_AGENT_REVIEWED,
  LABEL_AUTO_MERGED,
  type PrReview,
} from './pr-review-label.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExec(stdout = '', stderr = '') {
  return vi.fn().mockResolvedValue({ stdout, stderr });
}

function mockExecThrows(err: unknown) {
  return vi.fn().mockRejectedValue(err);
}

function makeReview(login: string, state = 'APPROVED'): PrReview {
  return { author: { login }, state, submittedAt: '2026-01-01T00:00:00Z' };
}

// ---------------------------------------------------------------------------
// isBotLogin
// ---------------------------------------------------------------------------

describe('isBotLogin', () => {
  it('returns true for hard-coded bot logins', () => {
    expect(isBotLogin('chatgpt-codex-connector')).toBe(true);
    expect(isBotLogin('vercel[bot]')).toBe(true);
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('github-actions[bot]')).toBe(true);
  });

  it('returns true for any login ending in [bot]', () => {
    expect(isBotLogin('renovate[bot]')).toBe(true);
    expect(isBotLogin('codecov[bot]')).toBe(true);
    expect(isBotLogin('stale[bot]')).toBe(true);
  });

  it('returns false for normal human logins', () => {
    expect(isBotLogin('griffinlong')).toBe(false);
    expect(isBotLogin('alice')).toBe(false);
    expect(isBotLogin('bob')).toBe(false);
  });

  it('returns false for logins that contain but do not end with [bot]', () => {
    expect(isBotLogin('[bot]user')).toBe(false);
    expect(isBotLogin('user[bot]user')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyReviews
// ---------------------------------------------------------------------------

describe('classifyReviews', () => {
  it('returns auto-merged when autoMerged flag is true', () => {
    const result = classifyReviews([], true);
    expect(result.label).toBe(LABEL_AUTO_MERGED);
  });

  it('returns auto-merged even when reviews are present', () => {
    const reviews = [makeReview('alice', 'APPROVED')];
    const result = classifyReviews(reviews, true);
    expect(result.label).toBe(LABEL_AUTO_MERGED);
  });

  it('returns human-reviewed when at least one human approved', () => {
    const reviews = [
      makeReview('alice', 'APPROVED'),
      makeReview('dependabot[bot]', 'APPROVED'),
    ];
    const result = classifyReviews(reviews);
    expect(result.label).toBe(LABEL_HUMAN_REVIEWED);
    if (result.label === LABEL_HUMAN_REVIEWED) {
      expect(result.humanLogins).toEqual(['alice']);
    }
  });

  it('returns human-reviewed when multiple humans approved', () => {
    const reviews = [makeReview('alice', 'APPROVED'), makeReview('bob', 'APPROVED')];
    const result = classifyReviews(reviews);
    expect(result.label).toBe(LABEL_HUMAN_REVIEWED);
    if (result.label === LABEL_HUMAN_REVIEWED) {
      expect(result.humanLogins).toEqual(['alice', 'bob']);
    }
  });

  it('returns agent-reviewed when only bots approved', () => {
    const reviews = [
      makeReview('dependabot[bot]', 'APPROVED'),
      makeReview('github-actions[bot]', 'APPROVED'),
    ];
    const result = classifyReviews(reviews);
    expect(result.label).toBe(LABEL_AGENT_REVIEWED);
    if (result.label === LABEL_AGENT_REVIEWED) {
      expect(result.botLogins).toEqual(['dependabot[bot]', 'github-actions[bot]']);
    }
  });

  it('returns agent-reviewed when there are no approvals at all', () => {
    const result = classifyReviews([]);
    expect(result.label).toBe(LABEL_AGENT_REVIEWED);
  });

  it('ignores non-APPROVED reviews (COMMENTED, CHANGES_REQUESTED)', () => {
    const reviews = [
      makeReview('alice', 'COMMENTED'),
      makeReview('bob', 'CHANGES_REQUESTED'),
      makeReview('dependabot[bot]', 'APPROVED'),
    ];
    const result = classifyReviews(reviews);
    // Only the bot approved — human didn't approve.
    expect(result.label).toBe(LABEL_AGENT_REVIEWED);
  });

  it('counts DISMISSED approvals as not APPROVED', () => {
    const reviews = [makeReview('alice', 'DISMISSED')];
    const result = classifyReviews(reviews);
    expect(result.label).toBe(LABEL_AGENT_REVIEWED);
  });
});

// ---------------------------------------------------------------------------
// fetchPrReviews
// ---------------------------------------------------------------------------

describe('fetchPrReviews', () => {
  it('parses reviews from gh output', async () => {
    const reviews: PrReview[] = [
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' },
    ];
    const exec = mockExec(JSON.stringify(reviews));
    const result = await fetchPrReviews('42', exec);
    expect(result).toEqual(reviews);
    expect(exec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'view', '42', '--json', 'reviews']),
    );
  });

  it('returns empty array when gh fails', async () => {
    const exec = mockExecThrows(new Error('gh: not found'));
    const result = await fetchPrReviews('42', exec);
    expect(result).toEqual([]);
  });

  it('returns empty array when output is invalid JSON', async () => {
    const exec = mockExec('not-json');
    const result = await fetchPrReviews('42', exec);
    expect(result).toEqual([]);
  });

  it('returns empty array when output is not an array', async () => {
    const exec = mockExec('{}');
    const result = await fetchPrReviews('42', exec);
    expect(result).toEqual([]);
  });

  it('filters out malformed review entries', async () => {
    const mixed = [
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '' },
      { author: null, state: 'APPROVED' }, // malformed — no login
      null,
    ];
    const exec = mockExec(JSON.stringify(mixed));
    const result = await fetchPrReviews('42', exec);
    expect(result).toHaveLength(1);
    expect(result[0].author.login).toBe('alice');
  });
});

// ---------------------------------------------------------------------------
// ensureLabelExists
// ---------------------------------------------------------------------------

describe('ensureLabelExists', () => {
  it('calls gh label create with correct args for human-reviewed', async () => {
    const exec = mockExec();
    await ensureLabelExists(LABEL_HUMAN_REVIEWED, exec);
    expect(exec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['label', 'create', 'human-reviewed', '--force']),
    );
  });

  it('calls gh label create with correct args for agent-reviewed', async () => {
    const exec = mockExec();
    await ensureLabelExists(LABEL_AGENT_REVIEWED, exec);
    expect(exec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['label', 'create', 'agent-reviewed', '--force']),
    );
  });

  it('calls gh label create with correct args for auto-merged', async () => {
    const exec = mockExec();
    await ensureLabelExists(LABEL_AUTO_MERGED, exec);
    expect(exec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['label', 'create', 'auto-merged', '--force']),
    );
  });

  it('does not throw when gh label create fails (fail-soft)', async () => {
    const exec = mockExecThrows(new Error('gh: label already exists'));
    await expect(ensureLabelExists(LABEL_HUMAN_REVIEWED, exec)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyReviewLabel
// ---------------------------------------------------------------------------

describe('applyReviewLabel', () => {
  it('adds the target label and removes siblings', async () => {
    const exec = mockExec();
    await applyReviewLabel('99', LABEL_HUMAN_REVIEWED, exec);

    const calls = exec.mock.calls.map((c) => c[1] as string[]);

    // Should add the target label
    const addCall = calls.find((a) => a.includes('--add-label') && a.includes('human-reviewed'));
    expect(addCall).toBeDefined();

    // Should attempt to remove sibling labels
    const removeAgentCall = calls.find(
      (a) => a.includes('--remove-label') && a.includes('agent-reviewed'),
    );
    const removeAutoCall = calls.find(
      (a) => a.includes('--remove-label') && a.includes('auto-merged'),
    );
    expect(removeAgentCall).toBeDefined();
    expect(removeAutoCall).toBeDefined();
  });

  it('does not throw when label operations fail (fail-soft)', async () => {
    const exec = mockExecThrows(new Error('gh: network error'));
    await expect(applyReviewLabel('99', LABEL_AGENT_REVIEWED, exec)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// labelPrReviewCoverage
// ---------------------------------------------------------------------------

describe('labelPrReviewCoverage', () => {
  it('returns auto-merged label and skips fetchPrReviews when autoMerged=true', async () => {
    const exec = mockExec();
    const label = await labelPrReviewCoverage('42', { autoMerged: true, execFn: exec });
    expect(label).toBe(LABEL_AUTO_MERGED);
    // fetchPrReviews should NOT have been called (no gh pr view call)
    const calls = exec.mock.calls.map((c) => c[1] as string[]);
    const viewCalls = calls.filter((a) => a.includes('pr') && a.includes('view'));
    expect(viewCalls).toHaveLength(0);
  });

  it('fetches reviews and returns human-reviewed label for human approvers', async () => {
    const reviews: PrReview[] = [
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '' },
    ];
    // First call → fetchPrReviews (returns JSON); subsequent calls → label ops (return '')
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(reviews), stderr: '' })
      .mockResolvedValue({ stdout: '', stderr: '' });

    const label = await labelPrReviewCoverage('42', { execFn: exec });
    expect(label).toBe(LABEL_HUMAN_REVIEWED);
  });

  it('fetches reviews and returns agent-reviewed label for bot-only approvers', async () => {
    const reviews: PrReview[] = [
      { author: { login: 'dependabot[bot]' }, state: 'APPROVED', submittedAt: '' },
    ];
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(reviews), stderr: '' })
      .mockResolvedValue({ stdout: '', stderr: '' });

    const label = await labelPrReviewCoverage('42', { execFn: exec });
    expect(label).toBe(LABEL_AGENT_REVIEWED);
  });

  it('returns agent-reviewed and does not throw when gh fails', async () => {
    const exec = mockExecThrows(new Error('network error'));
    const label = await labelPrReviewCoverage('42', { execFn: exec });
    // fetchPrReviews fails → empty reviews → agent-reviewed
    expect(label).toBe(LABEL_AGENT_REVIEWED);
  });
});
