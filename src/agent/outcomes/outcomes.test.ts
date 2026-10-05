/**
 * Unit tests for src/agent/outcomes/.
 *
 * All I/O is injected — no network, no filesystem access, no process.env reads.
 */

import { describe, it, expect } from 'vitest';
import { VerifiedOutcomeSchema } from './schema.js';
import {
  recoverCommitSHAs,
  recoverPRURLs,
  recoverArtifacts,
} from './artifacts.js';
import {
  parseSelfReport,
  lfErrorTail,
  lfVerification,
  lfInSessionCorrection,
  lfSelfReport,
  lfClosure,
  runImmediateLFs,
} from './lf-immediate.js';
import {
  parsePrUrl,
  lfPrFate,
  lfCommitSurvival,
} from './lf-delayed.js';
import { combine, computeConfidence } from './combine.js';
import { parseVerificationSummary } from './verification-patterns.js';
import { parseTerminalState } from './terminal-state.js';
import type { Vote } from './schema.js';
import type { Turn } from './artifacts.js';
import type { ClosureInfo } from './lf-immediate.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('VerifiedOutcomeSchema', () => {
  it('parses a minimal valid outcome', () => {
    const raw = {
      schema_version: 1,
      session_id: 'sess-123',
      label: 'unknown',
      confidence: 0,
      state: 'provisional',
      settles_after: null,
      session_kind: 'text',
      self_report: 'none',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
    };
    expect(VerifiedOutcomeSchema.safeParse(raw).success).toBe(true);
  });

  it('rejects an invalid label', () => {
    const raw = {
      schema_version: 1,
      session_id: 'x',
      label: 'great', // invalid
      confidence: 0,
      state: 'provisional',
      settles_after: null,
      session_kind: 'text',
      self_report: 'none',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
    };
    expect(VerifiedOutcomeSchema.safeParse(raw).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// artifacts.ts
// ---------------------------------------------------------------------------

describe('recoverCommitSHAs', () => {
  it('extracts a commit SHA from a normal git commit preview', () => {
    const turns: Turn[] = [
      {
        toolEvents: [
          {
            toolName: 'bash',
            input: 'git commit -m "feat: something"',
            result: '[feat/my-feature 2bb87cae] feat: something\n 3 files changed',
          },
        ],
      },
    ];
    expect(recoverCommitSHAs(turns)).toEqual(['2bb87cae']);
  });

  it('extracts a root-commit SHA', () => {
    const turns: Turn[] = [
      {
        toolEvents: [
          {
            toolName: 'bash',
            result: '[main (root-commit) 1a2b3c4d] initial commit',
          },
        ],
      },
    ];
    expect(recoverCommitSHAs(turns)).toEqual(['1a2b3c4d']);
  });

  it('skips errored tool events', () => {
    const turns: Turn[] = [
      {
        toolEvents: [
          {
            toolName: 'bash',
            result: '[main abc1234] oops',
            isError: true,
          },
        ],
      },
    ];
    expect(recoverCommitSHAs(turns)).toEqual([]);
  });

  it('deduplicates SHAs', () => {
    const turns: Turn[] = [
      {
        toolEvents: [
          { toolName: 'bash', result: '[main abc1234] first' },
          { toolName: 'bash', result: '[main abc1234] duplicate' },
        ],
      },
    ];
    expect(recoverCommitSHAs(turns)).toEqual(['abc1234']);
  });
});

describe('recoverPRURLs', () => {
  it('extracts the PR URL from a gh pr create event', () => {
    const turns: Turn[] = [
      {
        toolEvents: [
          {
            toolName: 'bash',
            input: 'cd /repo && gh pr create --body-file /tmp/b.md',
            result: 'https://github.com/myorg/myrepo/pull/42',
          },
        ],
      },
    ];
    expect(recoverPRURLs(turns)).toEqual(['https://github.com/myorg/myrepo/pull/42']);
  });

  it('accepts a bare-URL result when the stored input was truncated', () => {
    const turns: Turn[] = [
      {
        toolEvents: [
          {
            toolName: 'bash',
            input: 'cd /Users/x/Projects/very/long/path/.afk-worktrees/slug && git push -u origin \u2026',
            result: 'https://github.com/org/repo/pull/7\n',
          },
        ],
      },
    ];
    expect(recoverPRURLs(turns)).toEqual(['https://github.com/org/repo/pull/7']);
  });

  it('ignores PR URLs in assistant text', () => {
    const turns: Turn[] = [
      { assistant: 'See https://github.com/org/repo/pull/99', toolEvents: [] },
    ];
    expect(recoverPRURLs(turns)).toEqual([]);
  });

  it('ignores PR URLs printed by read-only gh queries', () => {
    const turns: Turn[] = [
      {
        toolEvents: [
          {
            toolName: 'bash',
            input: 'gh pr view 12 --json url -q .url',
            result: 'https://github.com/org/repo/pull/12',
          },
          {
            toolName: 'bash',
            input: 'gh pr list --state open',
            result: '12  fix thing  https://github.com/org/repo/pull/12',
          },
          {
            toolName: 'bash',
            input: 'cd /very/long/path && gh pr view 13 --json url \u2026',
            result: 'https://github.com/org/repo/pull/13',
          },
        ],
      },
    ];
    expect(recoverPRURLs(turns)).toEqual([]);
  });

  it('deduplicates PR URLs', () => {
    const turns: Turn[] = [
      {
        toolEvents: [
          { toolName: 'bash', input: 'gh pr create', result: 'https://github.com/org/repo/pull/1' },
          { toolName: 'bash', input: 'gh pr create', result: 'https://github.com/org/repo/pull/1' },
        ],
      },
    ];
    expect(recoverPRURLs(turns)).toHaveLength(1);
  });
});

describe('recoverArtifacts', () => {
  it('returns empty artifacts for empty turns', () => {
    const art = recoverArtifacts([]);
    expect(art.commits).toEqual([]);
    expect(art.prs).toEqual([]);
    expect(art.repo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lf-immediate.ts
// ---------------------------------------------------------------------------

describe('parseSelfReport', () => {
  // The implementation now delegates to parseTerminalState, which requires the
  // terminal-state keyword to be on its own short line (tail-anchored). Inputs
  // where the keyword appears inline mid-sentence correctly return 'none'.
  it('parses Done', () => expect(parseSelfReport('I ran the tests.\n\n**Done**\n- What was done: all tests pass')).toBe('done'));
  it('parses Blocked', () => expect(parseSelfReport('I tried the API.\n\n**Blocked**\n- What blocks: missing token')).toBe('blocked'));
  it('parses Asking', () => expect(parseSelfReport('I need a decision.\n\n**Asking**\n- Question: which approach?')).toBe('asking'));
  it('parses Interrupted', () => expect(parseSelfReport('**Interrupted**')).toBe('interrupted'));
  it('returns none when absent', () => expect(parseSelfReport('All good, nothing to say.')).toBe('none'));
  it('is case-insensitive', () => expect(parseSelfReport('**done**')).toBe('done'));
});

// ---------------------------------------------------------------------------
// parseSelfReport / parseTerminalState parity
//
// Both parsers must agree on the kind for the same input. These fixtures run
// through both and assert they produce matching results (or both return
// 'none'/null for non-terminal text).
// ---------------------------------------------------------------------------

describe('parseSelfReport / parseTerminalState parity', () => {
  // Shared fixtures: [label, assistantText, expected kind]
  const fixtures: Array<[string, string, 'done' | 'blocked' | 'asking' | 'interrupted' | 'none']> = [
    ['bold **Done**', 'prose\n\n**Done**\n- What was done: fixed it', 'done'],
    ['markdown ### Blocked', 'prose\n\n### Blocked\n- What blocks: no token', 'blocked'],
    ['plain Asking', 'prose\n\nAsking\n- Question: which branch?', 'asking'],
    ['Interrupted with trailing dot', 'prose\n\nInterrupted.\n- In progress: indexing', 'interrupted'],
    ['no terminal state', 'I read the file and it looks fine.', 'none'],
    [
      'fenced-code-block — done inside block must not match',
      // A shell loop that contains the word "done" should NOT be treated as a
      // terminal-state heading. The shared parseTerminalState skips fenced
      // lines; parseSelfReport must now agree.
      'Here is a script:\n\n```bash\nfor f in *.ts; do\n  echo $f\ndone\n```\n\nI ran it and everything compiled.',
      'none',
    ],
    [
      'done after fenced block is still detected',
      'Here is the output:\n\n```bash\ndone\n```\n\n**Done**\n- What was done: all tests pass',
      'done',
    ],
  ];

  for (const [label, text, expected] of fixtures) {
    it(label, () => {
      // parseSelfReport result
      const srResult = parseSelfReport(text);
      expect(srResult, `parseSelfReport("${label}")`).toBe(expected);

      // parseTerminalState result must agree
      const tsResult = parseTerminalState(text);
      if (expected === 'none') {
        expect(tsResult, `parseTerminalState("${label}")`).toBeNull();
      } else {
        expect(tsResult?.kind, `parseTerminalState("${label}").kind`).toBe(expected);
      }
    });
  }
});

// parseSelfReport / parseTerminalState intentional divergence
//
// parseSelfReport has a legacy inline-bold fallback (added in #2799) for the
// backfill path: historical transcripts used inline bold markers like
// "Task complete. **Done**" rather than a heading-only line. parseTerminalState
// is conservative and does NOT match those forms — the keyword is not on its
// own short line. Document the divergence explicitly so a future refactor does
// not accidentally collapse the two to the same behaviour.
// ---------------------------------------------------------------------------

describe('parseSelfReport / parseTerminalState intentional divergence', () => {
  it('Task complete. **Done** -> parseSelfReport done (legacy fallback), parseTerminalState null', () => {
    const text = 'Task complete. **Done**';
    // parseSelfReport recognises the inline bold marker via the legacy fallback.
    expect(parseSelfReport(text)).toBe('done');
    // parseTerminalState is conservative: the keyword is not on its own heading
    // line, so it returns null.
    expect(parseTerminalState(text)).toBeNull();
  });

  it('**Blocked** — needs credentials. -> parseSelfReport blocked (legacy fallback), parseTerminalState null', () => {
    const text = '**Blocked** — needs credentials.';
    expect(parseSelfReport(text)).toBe('blocked');
    expect(parseTerminalState(text)).toBeNull();
  });
});

describe('lfErrorTail', () => {
  const now = '2026-01-01T00:00:00.000Z';

  it('returns null when fewer than 3 events', () => {
    const turns: Turn[] = [{ toolEvents: [{ toolName: 'bash', isError: true }, { toolName: 'bash', isError: true }] }];
    expect(lfErrorTail(turns, now)).toBeNull();
  });

  it('returns null when last 3 are not all errors', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'bash', isError: true },
        { toolName: 'bash', isError: true },
        { toolName: 'read_file' }, // not error
      ],
    }];
    expect(lfErrorTail(turns, now)).toBeNull();
  });

  it('votes -1 when last 3 events are all errors', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'bash' },
        { toolName: 'bash', isError: true },
        { toolName: 'bash', isError: true },
        { toolName: 'bash', isError: true },
      ],
    }];
    const vote = lfErrorTail(turns, now);
    expect(vote).not.toBeNull();
    expect(vote?.vote).toBe(-1);
    expect(vote?.strength).toBe('strong');
  });
});

describe('lfVerification', () => {
  const now = '2026-01-01T00:00:00.000Z';

  it('returns null for non-mutating session', () => {
    const turns: Turn[] = [{ toolEvents: [{ toolName: 'read_file' }] }];
    expect(lfVerification(turns, now)).toBeNull();
  });

  it('returns null when no verification after last write', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file' },
        { toolName: 'read_file' }, // not a verification command
      ],
    }];
    expect(lfVerification(turns, now)).toBeNull();
  });

  it('votes +1 when pnpm test passes after write', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        { toolName: 'bash', input: 'pnpm test src/foo', isError: false },
      ],
    }];
    const vote = lfVerification(turns, now);
    expect(vote?.vote).toBe(1);
    expect(vote?.strength).toBe('strong');
  });

  it('abstains when isError was not recorded', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        { toolName: 'bash', input: 'pnpm test src/foo' },
      ],
    }];
    expect(lfVerification(turns, now)).toBeNull();
  });

  it.each([
    ['piped to tail', 'pnpm test 2>&1 | tail -5'],
    ['masked with || true', 'pnpm lint || true'],
    ['masked with || echo', 'pnpm build || echo failed'],
    ['masked with ; true', 'pnpm test; true'],
    ['truncated stored input', 'cd /very/long/path/.afk-worktrees/x && pnpm test src/agent/outcomes \u2026'],
  ])('abstains when the exit status is untrustworthy (%s)', (_label, input) => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        { toolName: 'bash', input, isError: false },
      ],
    }];
    expect(lfVerification(turns, now)).toBeNull();
  });

  it('abstains when the LAST verification is untrustworthy even if an earlier one was clean', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        { toolName: 'bash', input: 'pnpm test', isError: false },
        { toolName: 'bash', input: 'pnpm test 2>&1 | tail -3', isError: false },
      ],
    }];
    expect(lfVerification(turns, now)).toBeNull();
  });

  it('trusts the structured test_run tool', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'edit_file', input: '{}' },
        { toolName: 'test_run', input: '{"file":"src/x.test.ts"}', isError: true },
      ],
    }];
    expect(lfVerification(turns, now)?.vote).toBe(-1);
  });

  it('votes -1 when pnpm test fails (isError) after write', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        { toolName: 'bash', input: 'pnpm test src/foo', isError: true },
      ],
    }];
    expect(lfVerification(turns, now)?.vote).toBe(-1);
  });

  it('votes +1 from resultTail even when piped (isError untrustworthy)', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        {
          toolName: 'bash',
          input: 'pnpm test 2>&1 | tail -5',
          isError: false, // reflects pipe's exit status, not tests
          resultTail: 'Tests  42 passed (42)',
        },
      ],
    }];
    const vote = lfVerification(turns, now);
    expect(vote?.vote).toBe(1);
    expect(vote?.evidence).toContain('resultTail');
  });

  it('votes -1 from resultTail even when piped', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        {
          toolName: 'bash',
          input: 'pnpm test 2>&1 | tail -5',
          isError: false,
          resultTail: '3 failed | 10 passed',
        },
      ],
    }];
    expect(lfVerification(turns, now)?.vote).toBe(-1);
  });

  it('abstains when tail is present but ambiguous (falls back to exit-status rules)', () => {
    // Ambiguous tail → parseVerificationSummary returns null → fall back to
    // exit-status rules → piped command → abstain
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        {
          toolName: 'bash',
          input: 'pnpm test 2>&1 | tail -5',
          isError: false,
          resultTail: 'some other output with no test summary',
        },
      ],
    }];
    expect(lfVerification(turns, now)).toBeNull();
  });

  it('abstains when no tail and exit-status is untrustworthy (tail-absent fallback)', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        {
          toolName: 'bash',
          input: 'pnpm test 2>&1 | tail -5',
          isError: false,
          // no resultTail
        },
      ],
    }];
    expect(lfVerification(turns, now)).toBeNull();
  });

  it('uses exit-status fallback when no resultTail but command is unpiped', () => {
    const turns: Turn[] = [{
      toolEvents: [
        { toolName: 'write_file', input: '{}' },
        { toolName: 'bash', input: 'pnpm test src/foo', isError: false },
      ],
    }];
    const vote = lfVerification(turns, now);
    expect(vote?.vote).toBe(1);
    expect(vote?.evidence).toContain('isError');
  });
});

describe('parseVerificationSummary', () => {
  it('returns null for empty string', () => {
    expect(parseVerificationSummary('')).toBeNull();
  });

  it.each([
    ['vitest/jest passed', 'Tests  42 passed (42)', 'pass'],
    ['vitest/jest N passed', '10 passed | 0 failed', 'pass'],
    ['cargo/go ok', 'test result: ok. 5 passed; 0 failed', 'pass'],
    ['go test ok', 'ok      github.com/foo/bar  0.123s', 'pass'],
    ['eslint 0 problems', '0 problems (0 errors, 0 warnings)', 'pass'],
  ])('recognises pass: %s', (_label, tail, expected) => {
    expect(parseVerificationSummary(tail)).toBe(expected);
  });

  it.each([
    ['vitest/jest failed', '3 failed | 10 passed', 'fail'],
    ['tsc errors', 'Found 2 errors in 1 file', 'fail'],
    ['cargo/go FAILED', 'test result: FAILED. 0 passed; 1 failed', 'fail'],
    ['go FAIL', 'FAIL    github.com/foo/bar  0.456s', 'fail'],
    ['eslint problems', '5 problems (3 errors, 2 warnings)', 'fail'],
    ['pnpm ELIFECYCLE', 'npm ERR! code ELIFECYCLE\nnpm ERR! errno 1', 'fail'],
    ['Command failed', 'Error: Command failed: pnpm test\n exit code 1', 'fail'],
  ])('recognises fail: %s', (_label, tail, expected) => {
    expect(parseVerificationSummary(tail)).toBe(expected);
  });

  it('returns null for unrecognised output', () => {
    expect(parseVerificationSummary('Starting test runner...')).toBeNull();
  });

  it('handles multi-line tail', () => {
    const tail = 'Running tests...\n Tests  5 passed (5)\n Duration  1.23s';
    expect(parseVerificationSummary(tail)).toBe('pass');
  });
});

describe('lfInSessionCorrection', () => {
  const now = '2026-01-01T00:00:00.000Z';

  it('returns null when no correction language', () => {
    const turns: Turn[] = [
      { user: 'build this thing' },
      { user: 'looks great, thanks' },
    ];
    expect(lfInSessionCorrection(turns, now)).toBeNull();
  });

  it('ignores correction language in turn 0', () => {
    const turns: Turn[] = [{ user: 'no wait, wrong approach' }];
    expect(lfInSessionCorrection(turns, now)).toBeNull();
  });

  it('votes -1 on correction in turn 1+', () => {
    const turns: Turn[] = [
      { user: 'build this' },
      { user: 'no that is wrong, revert it' },
    ];
    const vote = lfInSessionCorrection(turns, now);
    expect(vote?.vote).toBe(-1);
    expect(vote?.strength).toBe('weak');
  });
});

describe('lfSelfReport', () => {
  const now = '2026-01-01T00:00:00.000Z';

  it('returns none when no turns', () => {
    const { selfReport } = lfSelfReport([], now);
    expect(selfReport).toBe('none');
  });

  it('picks the last non-none self-report', () => {
    const turns: Turn[] = [
      { assistant: 'I need a decision.\n\n**Asking**\n- Question: how do you want this?' },
      { assistant: 'I shipped the feature.\n\n**Done**\n- What was done: implemented.' },
    ];
    const { selfReport } = lfSelfReport(turns, now);
    expect(selfReport).toBe('done');
  });
});

describe('lfClosure', () => {
  const now = '2026-01-01T00:00:00.000Z';

  it('returns empty array when trace unavailable', () => {
    expect(lfClosure('sess', () => null, now)).toEqual([]);
  });

  it('votes -1 strong for abort', () => {
    const info: ClosureInfo = { reason: 'abort' };
    const votes = lfClosure('sess', () => info, now);
    expect(votes[0]?.vote).toBe(-1);
    expect(votes[0]?.lf).toBe('closure');
    expect(votes[0]?.strength).toBe('strong');
  });

  it('votes -1 weak for iteration_cap', () => {
    const info: ClosureInfo = { reason: 'iteration_cap' };
    const votes = lfClosure('sess', () => info, now);
    expect(votes[0]?.lf).toBe('budget_cap');
    expect(votes[0]?.strength).toBe('weak');
  });

  it('returns empty for normal closure', () => {
    const info: ClosureInfo = { reason: 'normal' };
    expect(lfClosure('sess', () => info, now)).toEqual([]);
  });
});

describe('runImmediateLFs', () => {
  const now = '2026-01-01T00:00:00.000Z';

  it('always includes a self_report vote', () => {
    const result = runImmediateLFs('sess', [], () => null, now);
    expect(result.votes.some((v) => v.lf === 'self_report')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lf-delayed.ts
// ---------------------------------------------------------------------------

describe('parsePrUrl', () => {
  it('parses a GitHub PR URL', () => {
    const r = parsePrUrl('https://github.com/myorg/myrepo/pull/42');
    expect(r?.repo).toBe('myorg/myrepo');
    expect(r?.number).toBe(42);
  });

  it('returns null for non-PR URL', () => {
    expect(parsePrUrl('https://example.com/foo')).toBeNull();
  });
});

describe('lfPrFate', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const url = 'https://github.com/org/repo/pull/1';

  it('votes +1 for merged PR', async () => {
    const votes = await lfPrFate(
      [url],
      async () => ({ state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' }),
      now,
    );
    expect(votes[0]?.vote).toBe(1);
    expect(votes[0]?.strength).toBe('strong');
  });

  it('votes -1 for closed unmerged PR', async () => {
    const votes = await lfPrFate(
      [url],
      async () => ({ state: 'CLOSED', mergedAt: null }),
      now,
    );
    expect(votes[0]?.vote).toBe(-1);
  });

  it('abstains for open PR', async () => {
    const votes = await lfPrFate(
      [url],
      async () => ({ state: 'OPEN', mergedAt: null }),
      now,
    );
    expect(votes).toHaveLength(0);
  });

  it('skips unavailable PR state', async () => {
    const votes = await lfPrFate([url], async () => null, now);
    expect(votes).toHaveLength(0);
  });
});

describe('lfCommitSurvival', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const sha = 'abc1234';
  const repo = '/some/repo';

  it('votes +1 when SHA is ancestor', async () => {
    const votes = await lfCommitSurvival(
      [sha], repo,
      async () => true,  // checkAncestor
      async () => false, // checkRevert
      now,
    );
    expect(votes[0]?.vote).toBe(1);
    expect(votes[0]?.strength).toBe('strong');
  });

  it('votes -1 when revert exists', async () => {
    const votes = await lfCommitSurvival(
      [sha], repo,
      async () => true,  // checkAncestor (ignored when reverted)
      async () => true,  // checkRevert
      now,
    );
    expect(votes[0]?.vote).toBe(-1);
  });

  it('abstains when not yet ancestor', async () => {
    const votes = await lfCommitSurvival(
      [sha], repo,
      async () => false, // not ancestor
      async () => false, // no revert
      now,
    );
    expect(votes).toHaveLength(0);
  });

  it('returns empty when repo is null', async () => {
    const votes = await lfCommitSurvival([sha], null, async () => true, async () => false, now);
    expect(votes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// combine.ts
// ---------------------------------------------------------------------------

function makeVote(lf: string, vote: 1 | -1 | 0, strength: 'strong' | 'weak'): Vote {
  return { lf, vote, strength, evidence: 'test', observed_at: '2026-01-01T00:00:00.000Z' };
}

const emptyArtifacts = { commits: [], prs: [], repo: null };

describe('computeConfidence', () => {
  it('returns 0 for unknown', () => {
    expect(computeConfidence('unknown', [])).toBe(0);
  });

  it('returns 1.0 for a single strong positive vote when label=succeeded', () => {
    expect(computeConfidence('succeeded', [makeVote('pr_fate', 1, 'strong')])).toBe(1);
  });

  it('discounts for weak disagreer', () => {
    const votes = [
      makeVote('pr_fate', 1, 'strong'),
      makeVote('error_tail', -1, 'weak'),
    ];
    const conf = computeConfidence('succeeded', votes);
    expect(conf).toBe(0.8); // 1.0 - 0.2
  });
});

describe('combine', () => {
  it('rule 1: closure abort + no artifacts → interrupted', () => {
    const result = combine({
      votes: [makeVote('closure', -1, 'strong')],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(result.label).toBe('interrupted');
  });

  it('rule 1 does NOT fire when artifacts exist', () => {
    const result = combine({
      votes: [makeVote('closure', -1, 'strong')],
      selfReport: 'none',
      artifacts: { commits: ['abc1234'], prs: [], repo: null },
    });
    // Falls through to rule 3 (strong -1, no strong +1)
    expect(result.label).toBe('failed');
  });

  it('rule 2: self_report=blocked → blocked', () => {
    const result = combine({
      votes: [],
      selfReport: 'blocked',
      artifacts: emptyArtifacts,
    });
    expect(result.label).toBe('blocked');
  });

  it('rule 3: strong -1, no strong +1 → failed', () => {
    const result = combine({
      votes: [makeVote('error_tail', -1, 'strong')],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(result.label).toBe('failed');
  });

  it('rule 4: strong +1, no strong -1 → succeeded', () => {
    const result = combine({
      votes: [makeVote('pr_fate', 1, 'strong')],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(result.label).toBe('succeeded');
  });

  it('rule 5: conflicting strong votes → unknown', () => {
    const result = combine({
      votes: [
        makeVote('pr_fate', 1, 'strong'),
        makeVote('error_tail', -1, 'strong'),
      ],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(result.label).toBe('unknown');
  });

  it('rule 5: no votes → unknown', () => {
    const result = combine({
      votes: [],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(result.label).toBe('unknown');
  });

  it('explicit_feedback good → succeeded (1.0)', () => {
    const result = combine({
      votes: [makeVote('error_tail', -1, 'strong')],
      selfReport: 'none',
      artifacts: emptyArtifacts,
      explicit_feedback: 'good',
    });
    expect(result.label).toBe('succeeded');
    expect(result.confidence).toBe(1.0);
  });

  it('explicit_feedback bad → failed (1.0)', () => {
    const result = combine({
      votes: [makeVote('pr_fate', 1, 'strong')],
      selfReport: 'none',
      artifacts: emptyArtifacts,
      explicit_feedback: 'bad',
    });
    expect(result.label).toBe('failed');
    expect(result.confidence).toBe(1.0);
  });

  it('fix_of_fix weak -1 cannot flip succeeded on its own', () => {
    // Strong +1 from pr_fate, only weak disagreer (fix_of_fix)
    const result = combine({
      votes: [
        makeVote('pr_fate', 1, 'strong'),
        makeVote('fix_of_fix', -1, 'weak'),
      ],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    // Rule 4 fires: strong +1, no strong -1 → succeeded (weak -1 lowers confidence)
    expect(result.label).toBe('succeeded');
    expect(result.confidence).toBeLessThan(1.0);
  });
});
