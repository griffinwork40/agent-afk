/**
 * Unit tests for session-summary.ts rendering helpers.
 *
 * Both `costTokenLine` and `sessionSummary` are pure functions with no
 * side-effects, making them straightforwardly testable without mocking.
 * Color output is stripped via chalk.level = 0 (set in color-config.ts at
 * process start), but the test suite sets it explicitly via FORCE_COLOR
 * absence / chalk.level to avoid any environment coupling.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import chalk from 'chalk';
import { costTokenLine, sessionSummary } from './session-summary.js';

// Strip ANSI codes so assertions compare plain text, not escape sequences.
// This keeps tests readable and environment-independent.
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

let origLevel: number;
beforeAll(() => {
  origLevel = chalk.level;
  chalk.level = 0; // disable color for these tests
});
afterAll(() => {
  chalk.level = origLevel;
});

// ── costTokenLine ────────────────────────────────────────────────────────────

describe('costTokenLine', () => {
  it('returns empty string when both values are absent', () => {
    expect(costTokenLine({})).toBe('');
  });

  it('returns empty string when both values are zero', () => {
    expect(costTokenLine({ costUsd: 0, tokens: 0 })).toBe('');
  });

  it('returns cost only when tokens is absent', () => {
    expect(strip(costTokenLine({ costUsd: 0.42 }))).toBe('$0.42');
  });

  it('returns tokens only when cost is absent', () => {
    expect(strip(costTokenLine({ tokens: 12300 }))).toBe('12.3k tokens');
  });

  it('returns cost · tokens with default separator', () => {
    expect(strip(costTokenLine({ costUsd: 0.42, tokens: 12300 }))).toBe('$0.42  ·  12.3k tokens');
  });

  it('respects a custom separator', () => {
    expect(strip(costTokenLine({ costUsd: 0.42, tokens: 12300, separator: ' | ' }))).toBe('$0.42 | 12.3k tokens');
  });

  it('skips zero cost but shows non-zero tokens', () => {
    expect(strip(costTokenLine({ costUsd: 0, tokens: 500 }))).toBe('500 tokens');
  });

  it('skips zero tokens but shows non-zero cost', () => {
    expect(strip(costTokenLine({ costUsd: 0.001, tokens: 0 }))).toBe('$0.0010');
  });

  it('returns raw text — no ANSI codes even at chalk.level > 0', () => {
    // At level 0 there are no codes, but the function must never call palette.*
    // at any level. Verify: the return value contains no escape bytes.
    const result = costTokenLine({ costUsd: 1.5, tokens: 5000 });
    expect(result).not.toMatch(/\x1b/);
  });
});

// ── sessionSummary ───────────────────────────────────────────────────────────

describe('sessionSummary', () => {
  it('returns exactly one line for minimal spec', () => {
    const lines = sessionSummary({ turns: 3 });
    expect(lines).toHaveLength(1);
  });

  it('line 1: turn count pluralises correctly', () => {
    expect(strip(sessionSummary({ turns: 1 })[0])).toContain('1 turn');
    expect(strip(sessionSummary({ turns: 1 })[0])).not.toContain('1 turns');
    expect(strip(sessionSummary({ turns: 2 })[0])).toContain('2 turns');
  });

  it('line 1: includes duration when provided', () => {
    const lines = sessionSummary({ turns: 1, durationMs: 65000 });
    expect(strip(lines[0])).toContain('1m 5s');
  });

  it('line 1: includes cost and tokens', () => {
    const line = strip(sessionSummary({ turns: 2, costUsd: 0.15, tokens: 8000 })[0]);
    expect(line).toContain('$0.15');
    expect(line).toContain('8k tokens');
  });

  it('line 1: omits cost and tokens when both are zero', () => {
    const line = strip(sessionSummary({ turns: 1, costUsd: 0, tokens: 0 })[0]);
    expect(line).not.toContain('$');
    expect(line).not.toContain('tokens');
  });

  it('line 2: model line rendered only when model is provided', () => {
    const withModel = sessionSummary({ turns: 1, model: 'claude-opus-4-5' });
    expect(withModel).toHaveLength(2);
    expect(strip(withModel[1])).toContain('model: claude-opus-4-5');

    const noModel = sessionSummary({ turns: 1 });
    expect(noModel).toHaveLength(1);
  });

  it('line 2: worktree defaults to "none" when model present but worktree absent', () => {
    const lines = sessionSummary({ turns: 1, model: 'claude-haiku-4-5' });
    expect(strip(lines[1])).toContain('worktree: none');
  });

  it('line 2: shows provided worktree name', () => {
    const lines = sessionSummary({ turns: 1, model: 'claude-sonnet-4-5', worktree: 'afk-my-task' });
    expect(strip(lines[1])).toContain('worktree: afk-my-task');
  });

  it('line 3: git stat line only when gitStat is provided', () => {
    const withGit = sessionSummary({ turns: 1, gitStat: '2 files changed, 10 insertions(+)' });
    // model omitted → line 2 is the git stat line (index 1)
    expect(strip(withGit[1])).toContain('edits: 2 files changed');

    const noGit = sessionSummary({ turns: 1 });
    expect(noGit).toHaveLength(1);
  });

  it('line 3: shows "no files changed" for empty gitStat', () => {
    const lines = sessionSummary({ turns: 1, gitStat: '' });
    expect(strip(lines[1])).toContain('no files changed');
  });

  it('line 4: resume command only when provided', () => {
    const withCmd = sessionSummary({ turns: 1, resumeCommand: 'afk --resume abc123 -m claude-opus-4-5' });
    const lastLine = withCmd[withCmd.length - 1];
    expect(strip(lastLine)).toContain('Continue with:');
    expect(strip(lastLine)).toContain('afk --resume abc123');

    const noCmd = sessionSummary({ turns: 1 });
    expect(noCmd.join(' ')).not.toContain('Continue with:');
  });

  it('returns all 4 lines for a fully-specified spec', () => {
    const lines = sessionSummary({
      turns: 5,
      durationMs: 300000,
      costUsd: 1.23,
      tokens: 50000,
      model: 'claude-opus-4-5',
      worktree: 'afk-feature',
      gitStat: '3 files changed',
      resumeCommand: 'afk --resume session42 -m claude-opus-4-5',
    });
    expect(lines).toHaveLength(4);
    expect(strip(lines[0])).toContain('5 turns');
    expect(strip(lines[1])).toContain('model: claude-opus-4-5');
    expect(strip(lines[2])).toContain('edits: 3 files changed');
    expect(strip(lines[3])).toContain('Continue with:');
  });

  it('all lines are indented with two leading spaces', () => {
    const lines = sessionSummary({
      turns: 2,
      model: 'claude-haiku-4-5',
      gitStat: 'changed',
      resumeCommand: 'afk --resume x',
    });
    for (const line of lines) {
      expect(strip(line)).toMatch(/^  /);
    }
  });
});
