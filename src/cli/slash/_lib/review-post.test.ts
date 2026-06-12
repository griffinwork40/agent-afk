/**
 * Tests for src/cli/slash/_lib/review-post.ts
 *
 * Pure helpers (parse / chunk / build / summarize) plus the fail-soft
 * orchestrator with fully-injected deps — no real `gh`, no real Telegram.
 */

import { describe, it, expect, vi } from 'vitest';

import type { Writer } from '../types.js';
import {
  parsePostFlag,
  parsePostTargets,
  chunkText,
  buildGithubBody,
  summarizeForTelegram,
  runReviewPostPublish,
  REVIEW_MARKER,
  type ReviewPostDeps,
} from './review-post.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A Writer that records every call so assertions can inspect output. */
function mockWriter(): Writer & {
  warns: string[];
  successes: string[];
  errors: string[];
} {
  const warns: string[] = [];
  const successes: string[] = [];
  const errors: string[] = [];
  return {
    line: () => {},
    raw: () => {},
    info: () => {},
    warn: (t = '') => { warns.push(t); },
    success: (t = '') => { successes.push(t); },
    error: (t = '') => { errors.push(t); },
    warns,
    successes,
    errors,
  };
}

/** Default happy-path deps; override per-test. */
function deps(overrides: Partial<ReviewPostDeps> = {}): Partial<ReviewPostDeps> {
  return {
    checkGhReady: vi.fn().mockResolvedValue({ ok: true }),
    postPrComment: vi.fn().mockResolvedValue('https://github.com/o/r/pull/7#issuecomment-9'),
    resolveCurrentBranchPr: vi.fn().mockResolvedValue('7'),
    pushIfConfigured: vi.fn().mockResolvedValue([{ ok: true, status: 200 }]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parsePostFlag
// ---------------------------------------------------------------------------

describe('parsePostFlag', () => {
  it('extracts a single target and strips it from args', () => {
    const r = parsePostFlag('277 --post github');
    expect(r.targets).toEqual(['github']);
    expect(r.cleanedArgs).toBe('277');
    expect(r.unknown).toEqual([]);
  });

  it('supports the = form', () => {
    expect(parsePostFlag('--post=telegram --staged').targets).toEqual(['telegram']);
    expect(parsePostFlag('--post=telegram --staged').cleanedArgs).toBe('--staged');
  });

  it('supports comma lists', () => {
    expect(parsePostFlag('--post github,telegram').targets).toEqual(['github', 'telegram']);
  });

  it('supports repeated flags and dedupes', () => {
    expect(parsePostFlag('--post github --post github --post telegram').targets).toEqual([
      'github',
      'telegram',
    ]);
  });

  it('collects unknown targets and leaves valid args intact', () => {
    const r = parsePostFlag('--head --post slack');
    expect(r.targets).toEqual([]);
    expect(r.unknown).toEqual(['slack']);
    expect(r.cleanedArgs).toBe('--head');
  });

  it('strips a dangling bare --post with no value', () => {
    const r = parsePostFlag('277 --post');
    expect(r.targets).toEqual([]);
    expect(r.cleanedArgs).toBe('277');
  });

  it('is a no-op when --post is absent', () => {
    const r = parsePostFlag('--staged --light');
    expect(r.targets).toEqual([]);
    expect(r.cleanedArgs).toBe('--staged --light');
  });

  it('leaves args verbatim (no trim/collapse) when --post is absent', () => {
    // Guards the preflight rawArgs-verbatim contract (plugin-skills-preflight).
    const r = parsePostFlag('  277 --verbose  ');
    expect(r.cleanedArgs).toBe('  277 --verbose  ');
  });

  it('preserves a PR URL as the review target', () => {
    const r = parsePostFlag('https://github.com/o/r/pull/12 --post github');
    expect(r.cleanedArgs).toBe('https://github.com/o/r/pull/12');
  });
});

// ---------------------------------------------------------------------------
// parsePostTargets — bare-value classifier (CLI `chat --post` path)
// ---------------------------------------------------------------------------

describe('parsePostTargets', () => {
  it('classifies a single target', () => {
    expect(parsePostTargets('github')).toEqual({ targets: ['github'], unknown: [] });
  });

  it('classifies a comma list and dedupes', () => {
    expect(parsePostTargets('github,telegram,github')).toEqual({
      targets: ['github', 'telegram'],
      unknown: [],
    });
  });

  it('collects unknown targets without throwing', () => {
    expect(parsePostTargets('github,slack')).toEqual({
      targets: ['github'],
      unknown: ['slack'],
    });
  });

  it('trims whitespace and ignores empty members', () => {
    expect(parsePostTargets(' github , , telegram ')).toEqual({
      targets: ['github', 'telegram'],
      unknown: [],
    });
  });

  it('returns empty arrays for an empty value', () => {
    expect(parsePostTargets('')).toEqual({ targets: [], unknown: [] });
  });
});

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(chunkText('short', 4096)).toEqual(['short']);
  });

  it('splits on line boundaries', () => {
    const text = 'aaaa\nbbbb\ncccc';
    const chunks = chunkText(text, 9); // "aaaa\nbbbb" = 9 chars
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(9);
    expect(chunks.join('\n')).toBe(text);
  });

  it('hard-splits a single line longer than the limit', () => {
    const chunks = chunkText('x'.repeat(25), 10);
    expect(chunks).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  it('never emits a chunk longer than the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'y'.repeat(i)}`).join('\n');
    for (const c of chunkText(text, 40)) expect(c.length).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// buildGithubBody
// ---------------------------------------------------------------------------

describe('buildGithubBody', () => {
  it('prepends the marker and includes the review + footer', () => {
    const body = buildGithubBody('  ## Findings\n- nit: foo  ');
    expect(body.startsWith(REVIEW_MARKER)).toBe(true);
    expect(body).toContain('## Findings');
    expect(body).toContain('agent-afk /review --post github');
  });
});

// ---------------------------------------------------------------------------
// summarizeForTelegram
// ---------------------------------------------------------------------------

describe('summarizeForTelegram', () => {
  it('detects DO NOT MERGE', () => {
    expect(summarizeForTelegram('Decision: **DO NOT MERGE**')).toContain('DO NOT MERGE');
  });

  it('detects MERGE', () => {
    const s = summarizeForTelegram('Decision: **MERGE**\nAll clear.');
    expect(s).toContain('MERGE');
    expect(s).not.toContain('DO NOT MERGE');
  });

  it('falls back to a neutral header when no decision token is present', () => {
    expect(summarizeForTelegram('some prose with no verdict')).toContain('Review complete');
  });

  it('lifts high-signal finding lines with citations', () => {
    const review = [
      '## Summary',
      'Decision: DO NOT MERGE',
      '',
      '- critical: SQL injection in src/db/query.ts:42',
      '- nit: rename a variable',
      '- high: missing auth check at src/api/handler.ts:88',
    ].join('\n');
    const s = summarizeForTelegram(review);
    expect(s).toContain('src/db/query.ts:42');
    expect(s).toContain('src/api/handler.ts:88');
  });
});

// ---------------------------------------------------------------------------
// runReviewPostPublish — orchestrator (fail-soft)
// ---------------------------------------------------------------------------

describe('runReviewPostPublish', () => {
  it('warns and does nothing when the review text is empty', async () => {
    const out = mockWriter();
    const d = deps();
    await runReviewPostPublish(out, { targets: ['github'], reviewText: '   ', prRefFromArgs: null }, d);
    expect(out.warns.some((w) => /no review output/.test(w))).toBe(true);
    expect(d.postPrComment).not.toHaveBeenCalled();
  });

  it('github: posts a marker-tagged comment to the PR ref from args', async () => {
    const out = mockWriter();
    const post = vi.fn().mockResolvedValue('https://github.com/o/r/pull/277#issuecomment-1');
    const resolveCurrentBranchPr = vi.fn();
    const d = deps({ postPrComment: post, resolveCurrentBranchPr });
    await runReviewPostPublish(
      out,
      { targets: ['github'], reviewText: 'MERGE — looks good', prRefFromArgs: '277' },
      d,
    );
    expect(post).toHaveBeenCalledTimes(1);
    const arg = post.mock.calls[0]![0] as { pr: string; body: string };
    expect(arg.pr).toBe('277');
    expect(arg.body.startsWith(REVIEW_MARKER)).toBe(true);
    // PR ref came from args, so no current-branch resolution needed.
    expect(resolveCurrentBranchPr).not.toHaveBeenCalled();
    expect(out.successes.some((s) => /PR #277/.test(s))).toBe(true);
  });

  it('github: resolves the current-branch PR when args carry no ref', async () => {
    const out = mockWriter();
    const resolve = vi.fn().mockResolvedValue('99');
    const post = vi.fn().mockResolvedValue('');
    const d = deps({ resolveCurrentBranchPr: resolve, postPrComment: post });
    await runReviewPostPublish(out, { targets: ['github'], reviewText: 'MERGE', prRefFromArgs: null }, d);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0]![0] as { pr: string }).pr).toBe('99');
  });

  it('github: skips (warns) when gh is not ready', async () => {
    const out = mockWriter();
    const post = vi.fn();
    const d = deps({
      checkGhReady: vi.fn().mockResolvedValue({ ok: false, hint: '`gh` is not authenticated — run: gh auth login' }),
      postPrComment: post,
    });
    await runReviewPostPublish(out, { targets: ['github'], reviewText: 'MERGE', prRefFromArgs: '1' }, d);
    expect(post).not.toHaveBeenCalled();
    expect(out.warns.some((w) => /not authenticated/.test(w))).toBe(true);
  });

  it('github: skips (warns) when no PR ref and no current-branch PR', async () => {
    const out = mockWriter();
    const post = vi.fn();
    const d = deps({ resolveCurrentBranchPr: vi.fn().mockResolvedValue(null), postPrComment: post });
    await runReviewPostPublish(out, { targets: ['github'], reviewText: 'MERGE', prRefFromArgs: null }, d);
    expect(post).not.toHaveBeenCalled();
    expect(out.warns.some((w) => /no PR to comment on/.test(w))).toBe(true);
  });

  it('github: fail-soft — a thrown postPrComment is reported, not rethrown', async () => {
    const out = mockWriter();
    const d = deps({ postPrComment: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(
      runReviewPostPublish(out, { targets: ['github'], reviewText: 'MERGE', prRefFromArgs: '1' }, d),
    ).resolves.toBeUndefined();
    expect(out.warns.some((w) => /github failed: boom/.test(w))).toBe(true);
  });

  it('telegram: sends a summary and reports success', async () => {
    const out = mockWriter();
    const push = vi.fn().mockResolvedValue([{ ok: true, status: 200 }]);
    const d = deps({ pushIfConfigured: push });
    await runReviewPostPublish(
      out,
      { targets: ['telegram'], reviewText: 'DO NOT MERGE\n- critical: x at a/b.ts:1', prRefFromArgs: null },
      d,
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(out.successes.some((s) => /Telegram/.test(s))).toBe(true);
  });

  it('telegram: skips (warns) when unconfigured (pushIfConfigured returns null)', async () => {
    const out = mockWriter();
    const d = deps({ pushIfConfigured: vi.fn().mockResolvedValue(null) });
    await runReviewPostPublish(out, { targets: ['telegram'], reviewText: 'MERGE', prRefFromArgs: null }, d);
    expect(out.warns.some((w) => /not configured/.test(w))).toBe(true);
  });

  it('telegram: fail-soft — a thrown push is reported, not rethrown', async () => {
    const out = mockWriter();
    const d = deps({ pushIfConfigured: vi.fn().mockRejectedValue(new Error('net down')) });
    await expect(
      runReviewPostPublish(out, { targets: ['telegram'], reviewText: 'MERGE', prRefFromArgs: null }, d),
    ).resolves.toBeUndefined();
    expect(out.warns.some((w) => /telegram failed: net down/.test(w))).toBe(true);
  });

  it('runs every requested target independently', async () => {
    const out = mockWriter();
    const post = vi.fn().mockResolvedValue('url');
    const push = vi.fn().mockResolvedValue([{ ok: true, status: 200 }]);
    const d = deps({ postPrComment: post, pushIfConfigured: push });
    await runReviewPostPublish(
      out,
      { targets: ['github', 'telegram'], reviewText: 'MERGE', prRefFromArgs: '3' },
      d,
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
