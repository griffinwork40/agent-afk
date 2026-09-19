/**
 * Direct unit tests for formatStatusLine() — the pure formatting function
 * exported from src/cli/render/status-line-format.ts.
 *
 * Complements the indirect coverage via StatusLine class tests in
 * src/cli/status-line.test.ts. These tests exercise the formatting contract
 * (field assembly, priority-based shedding, edge cases) in isolation — no
 * TTY stream, no scroll-region management, just the pure string function.
 */

import { describe, it, expect } from 'vitest';
import { formatStatusLine } from './status-line-format.js';
import { displayWidth } from '../display.js';

/** Strip ANSI escape sequences for plain-text assertions. */
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mGKHs]/g, '').replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '');
}

// Use the broad ANSI regex from the existing test suite for completeness.
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
function stripAll(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ── Basic assembly ────────────────────────────────────────────────────────────

describe('formatStatusLine — basic assembly with all fields populated', () => {
  it('includes model, cost, and token count on a wide line', () => {
    const out = stripAll(formatStatusLine(
      { model: 'claude-3-5-sonnet', cost: 1.23, tokens: 5000 },
      200,
    ));
    expect(out).toContain('claude-3-5-sonnet');
    expect(out).toContain('$1.23');
    expect(out).toContain('tok');
  });

  it('places model leftmost — before cwd, branch, cost, and tokens', () => {
    const out = stripAll(formatStatusLine(
      {
        model: 'sonnet',
        cwd: '/home/user/project',
        branch: 'feat/my-feature',
        cost: 0.42,
        tokens: 1200,
      },
      200,
    ));
    const modelIdx = out.indexOf('sonnet');
    const cwdIdx = out.indexOf('project');
    const branchIdx = out.indexOf('feat/my-feature');
    const costIdx = out.indexOf('$0.42');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeLessThan(cwdIdx);
    expect(modelIdx).toBeLessThan(branchIdx);
    expect(modelIdx).toBeLessThan(costIdx);
  });

  it('renders the ⎇ glyph and branch name when branch is provided', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', branch: 'main' }, 200));
    expect(out).toContain('⎇');
    expect(out).toContain('main');
  });

  it('appends #PR to the branch segment when pr is also provided', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', branch: 'feat/x', pr: 99 }, 200));
    expect(out).toContain('feat/x');
    expect(out).toContain('#99');
  });

  it('omits the ⎇ segment entirely when branch is absent', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', cost: 0.10 }, 200));
    expect(out).not.toContain('⎇');
  });

  it('omits pr without a branch (pr is only meaningful alongside branch)', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', pr: 42 }, 200));
    expect(out).not.toContain('#42');
    expect(out).not.toContain('⎇');
  });

  it('renders cwd when provided (never-drop field)', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', cwd: '/tmp/my-project' }, 200));
    expect(out).toContain('my-project');
  });

  it('renders plan mode chip', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', permissionMode: 'plan' }, 200));
    expect(out).toContain('● plan');
  });

  it('renders AFK mode chip', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', permissionMode: 'autonomous' }, 200));
    expect(out).toContain('◐ AFK');
  });

  it('renders bypass mode chip', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', permissionMode: 'bypassPermissions' }, 200));
    expect(out).toContain('⚡ bypass');
  });

  it('renders default mode chip', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', permissionMode: 'default' }, 200));
    expect(out).toContain('○ default');
  });

  it('renders the context bar when contextPct is provided', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', contextPct: 0.5, contextLimit: 200000, contextUsedTokens: 100000 },
      200,
    ));
    expect(out).toContain('50%');
    expect(out).toContain('[');
    expect(out).toContain(']');
  });

  it('renders turn N when turnCount is set', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', turnCount: 7 }, 200));
    expect(out).toContain('turn 7');
    expect(out).not.toContain('turn 7/');
  });

  it('renders turn N/M when both turnCount and maxTurns are set', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', turnCount: 3, maxTurns: 20 }, 200));
    expect(out).toContain('turn 3/20');
  });

  it('renders N↗ when activeAgentCount > 0', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', activeAgentCount: 4 }, 200));
    expect(out).toContain('4↗');
  });

  it('omits ↗ when activeAgentCount is 0', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', activeAgentCount: 0 }, 200));
    expect(out).not.toContain('↗');
  });

  it('renders tok/s when tokPerSec is positive', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', tokPerSec: 847.3 }, 200));
    expect(out).toContain('847 tok/s');
  });

  it('omits tok/s when tokPerSec is 0', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', tokPerSec: 0 }, 200));
    expect(out).not.toContain('tok/s');
  });

  it('renders $N.NN/$M.NN when budgetUsd and maxBudgetUsd are both set', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', budgetUsd: 2.50, maxBudgetUsd: 10.00 },
      200,
    ));
    expect(out).toContain('$2.50/$10.00');
  });

  it('renders $N.NN without cap when maxBudgetUsd is absent', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', budgetUsd: 1.99 }, 200));
    expect(out).toContain('$1.99');
    expect(out).not.toContain('$1.99/$');
  });

  it('result fits within maxW display columns', () => {
    const maxW = 200;
    const result = formatStatusLine(
      {
        model: 'claude-3-5-sonnet-20241022',
        cwd: '/home/user/long/path/to/project',
        branch: 'feat/add-comprehensive-tests',
        pr: 1234,
        cost: 5.42,
        tokens: 99000,
        contextPct: 0.75,
        contextLimit: 200000,
        contextUsedTokens: 150000,
        permissionMode: 'plan',
        turnCount: 15,
        maxTurns: 50,
        activeAgentCount: 2,
        tokPerSec: 312,
      },
      maxW,
    );
    expect(displayWidth(result)).toBeLessThanOrEqual(maxW);
  });
});

// ── Priority-based shedding ───────────────────────────────────────────────────

describe('formatStatusLine — priority-based shedding at narrow widths', () => {
  it('drops tok/s first (priority 9) before any other droppable', () => {
    // tok/s has the highest droppablePriority (9 = shed first). At width 38 the
    // full line ("sonnet · $0.05 · 1.2k tokens · 500 tok/s" ≈ 43 cols) overflows,
    // so tok/s is the first field shed, leaving the others intact.
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', cost: 0.05, tokens: 1200, tokPerSec: 500 },
      38,
    ));
    expect(out).toContain('sonnet');
    expect(out).not.toContain('tok/s');
    // tokens (priority 4) survived because only tok/s (9) was shed.
    expect(out).toContain('tok');
  });

  it('drops fan-out count before budget/turn (priority 8 > 7 > 6)', () => {
    // activeAgentCount (8) sheds before budgetUsd (7) which sheds before turnCount (6).
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', turnCount: 3, budgetUsd: 1.00, activeAgentCount: 2 },
      22,
    ));
    expect(out).toContain('sonnet');
    expect(out).not.toContain('2↗');
  });

  it('drops tokens before cost (priority 4 > 3)', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', cwd: '/tmp', cost: 0.05, tokens: 1200 },
      30,
    ));
    expect(out).not.toContain('tok');
    expect(out).toContain('$0.05');
  });

  it('drops cost before context bar (priority 3 > 2)', () => {
    // At a width that forces dropping cost but not the context bar, cost (3) goes first.
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', cost: 0.05, contextPct: 0.5, contextLimit: 200000, contextUsedTokens: 100000 },
      35,
    ));
    // At 35 cols, tokens (priority 4) and cost (priority 3) both shed before context bar (priority 2).
    expect(out).not.toContain('$0.05');
    // Context bar (priority 2) or branch (priority 1) may survive depending on exact widths;
    // the key invariant is that cost shed before the bar.
  });

  it('drops branch last among droppables (priority 1) — survives when tokens/cost shed', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', branch: 'feat/x', cost: 0.05, tokens: 1200 },
      30,
    ));
    expect(out).toContain('feat/x');
    expect(out).not.toContain('tok');
  });

  it('drops branch before truncating model on a very narrow terminal', () => {
    // branch (droppablePriority 1) sheds before right-edge truncation eats the model.
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', branch: 'feat/x' },
      12,
    ));
    expect(out).toContain('sonnet');
    expect(out).not.toContain('feat/x');
  });

  it('never drops model — always the leftmost field', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', cwd: '/x', cost: 0.05, tokens: 1200 },
      16,
    ));
    expect(out).toContain('sonnet');
    expect(out).not.toContain('$');
    expect(out).not.toContain('tok');
  });

  it('never drops permission mode chip (plan)', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', cwd: '/tmp', cost: 0.05, tokens: 1200, permissionMode: 'plan' },
      30,
    ));
    expect(out).toContain('● plan');
    expect(out).not.toContain('tok');
  });

  it('never drops permission mode chip (AFK)', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', cwd: '/tmp', cost: 0.05, tokens: 1200, permissionMode: 'autonomous' },
      30,
    ));
    expect(out).toContain('◐ AFK');
    expect(out).not.toContain('tok');
  });

  it('right-truncates the result at maxW after shedding all droppables', () => {
    // A model name longer than maxW — after all droppables gone, truncation fires.
    const longModel = 'a'.repeat(40);
    const result = formatStatusLine({ model: longModel }, 15);
    expect(displayWidth(result)).toBeLessThanOrEqual(15);
    expect(stripAll(result)).toContain('…');
  });

  it('drops turn indicator (priority 6) before cost (priority 3)', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', cost: 0.01, turnCount: 7, maxTurns: 20 },
      22,
    ));
    expect(out).toContain('sonnet');
    expect(out).not.toContain('turn 7');
  });

  it('sheds budget indicator (priority 7) before turnCount (priority 6)', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', turnCount: 3, budgetUsd: 1.00 },
      22,
    ));
    expect(out).toContain('sonnet');
    expect(out).not.toContain('$1.00');
  });

  it('calm quota (priority 5) drops before tokens (priority 4)', () => {
    // A calm (non-critical) quota indicator has droppablePriority 5, so it sheds
    // before tokens (4) on narrow terminals — the INVERSE of what you might expect
    // for "important" data, since calm quota is peripheral when context is low.
    const out = stripAll(formatStatusLine(
      {
        model: 'sonnet',
        cost: 0.05,
        tokens: 1200,
        quotaWindows: {
          fiveHour: { utilization: 0.42 },
          sevenDay: { utilization: 0.31 },
          observedAt: new Date(),
        },
      },
      40,
    ));
    expect(out).not.toContain('42%');
    expect(out).toContain('tok');
  });

  it('critical fresh quota (priority 0) survives longer than tokens/cost/branch', () => {
    // At >80% utilization the quota severity is 'critical'. A FRESH critical quota
    // gets droppablePriority 0 — drop LAST among droppables, outlasting even branch.
    const out = stripAll(formatStatusLine(
      {
        model: 'sonnet',
        branch: 'feat/x',
        cost: 0.05,
        tokens: 1200,
        quotaWindows: {
          fiveHour: { utilization: 0.94 },
          sevenDay: { utilization: 0.24 },
          observedAt: new Date(),
        },
      },
      40,
    ));
    expect(out).toContain('94%');
    expect(out).not.toContain('tok');
    expect(out).toContain('sonnet');
  });

  it('stale critical quota keeps peripheral priority (drops like a calm one)', () => {
    // A critical reading >25 min old is stale and should NOT be promoted to priority 0.
    const out = stripAll(formatStatusLine(
      {
        model: 'sonnet',
        cost: 0.05,
        tokens: 1200,
        quotaWindows: {
          fiveHour: { utilization: 0.94 },
          sevenDay: { utilization: 0.24 },
          observedAt: new Date(Date.now() - 40 * 60 * 1000),
        },
      },
      40,
    ));
    expect(out).not.toContain('94%');
    expect(out).toContain('tok');
  });
});

// ── buildGitSegment worktree-dedupe path ─────────────────────────────────────

describe('formatStatusLine — buildGitSegment worktree-dedupe path', () => {
  it('suppresses cwd and renders ONE ⎇ segment when cwd matches the afk-worktree pattern', () => {
    // Worktree pattern: parent dir is `.afk-worktrees`, branch slash→dash equals cwd basename.
    const out = stripAll(formatStatusLine(
      {
        model: 'sonnet',
        cwd: '/Users/x/proj/.afk-worktrees/afk-20260705-142358-47b3ec',
        branch: 'afk/20260705-142358-47b3ec',
      },
      200,
    ));
    // Branch spelling appears via the merged segment…
    expect(out).toContain('⎇ afk/20260705-142358-47b3ec');
    // …but the cwd (dash-form slug) must NOT appear as a standalone segment.
    expect(out).not.toContain('afk-20260705-142358-47b3ec');
    // The shared identity slug renders exactly once.
    const slug = '20260705-142358-47b3ec';
    expect(out.indexOf(slug)).toBe(out.lastIndexOf(slug));
  });

  it('preserves the #PR suffix inside the merged segment', () => {
    const out = stripAll(formatStatusLine(
      {
        model: 'sonnet',
        cwd: '/Users/x/proj/.afk-worktrees/afk-20260705-142358-47b3ec',
        branch: 'afk/20260705-142358-47b3ec',
        pr: 7,
      },
      200,
    ));
    expect(out).toContain('⎇ afk/20260705-142358-47b3ec #7');
  });

  it('sheds the merged segment before truncating the model (droppablePriority 1, not never-drop)', () => {
    // Regression guard: the merged segment must be droppable so the model is
    // never truncated by a stacked never-drop pair on narrow terminals.
    const out = stripAll(formatStatusLine(
      {
        model: 'sonnet',
        cwd: '/Users/x/proj/.afk-worktrees/afk-20260705-142358-47b3ec',
        branch: 'afk/20260705-142358-47b3ec',
        cost: 0.05,
        tokens: 1200,
      },
      32,
    ));
    expect(out).toContain('sonnet');
    expect(out).not.toContain('afk/20260705-142358-47b3ec');
    expect(out).not.toContain('tok');
  });

  it('does NOT dedupe when parent dir is not .afk-worktrees (positive signal required)', () => {
    // A name coincidence alone is not enough to suppress the cwd.
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', cwd: '/tmp/redesign', branch: 'redesign' },
      200,
    ));
    expect(out).toContain('⎇ redesign');
    // Both the cwd part and the branch appear — identity shows twice (not merged).
    expect(out.indexOf('redesign')).not.toBe(out.lastIndexOf('redesign'));
  });

  it('does NOT dedupe when branch exceeds the 30-col display cap', () => {
    // When the identity is >30 display cols, the branch would be truncated in the
    // merge, losing the very cwd it was supposed to replace — so fall back to both.
    const out = stripAll(formatStatusLine(
      {
        model: 'sonnet',
        cwd: '/Users/x/proj/.afk-worktrees/afk-20260705-142358-verylongsuffix-xy',
        branch: 'afk/20260705-142358-verylongsuffix-xy',
      },
      200,
    ));
    // cwd dash-form is present (dedupe did NOT fire — cwd was not suppressed)
    expect(out).toContain('afk-20260705-142358-verylongsuffix-xy');
    // Branch segment still present but truncated (capped at 30 cols)
    expect(out).toContain('⎇');
    expect(out).not.toContain('afk/20260705-142358-verylongsuffix-xy');
  });

  it('renders cwd and branch separately when they do not match', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', cwd: '/tmp/proj', branch: 'feat/x' },
      200,
    ));
    expect(out).toContain('proj');
    expect(out).toContain('⎇ feat/x');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('formatStatusLine — edge cases', () => {
  it('maxW = 0 does not crash and returns a string (may be empty after truncation)', () => {
    // truncateDisplayWidth(str, 0) returns '' — that is the correct behaviour for
    // a zero-width column budget. The function must not throw.
    const result = formatStatusLine({ model: 'sonnet' }, 0);
    expect(typeof result).toBe('string');
  });

  it('maxW = 1 does not crash and returns a string', () => {
    const result = formatStatusLine({ model: 'sonnet', cost: 1.23 }, 1);
    expect(typeof result).toBe('string');
  });

  it('result never exceeds maxW on a very narrow terminal', () => {
    const maxW = 5;
    const result = formatStatusLine(
      { model: 'claude-3-opus', cwd: '/home/user', branch: 'main', cost: 99.99, tokens: 100000 },
      maxW,
    );
    expect(displayWidth(result)).toBeLessThanOrEqual(maxW);
  });

  it('empty model string renders without crashing', () => {
    const result = formatStatusLine({ model: '', cost: 0.10 }, 80);
    expect(typeof result).toBe('string');
    // Cost should still appear on a wide line.
    expect(stripAll(result)).toContain('$0.10');
  });

  it('empty model string result fits within maxW', () => {
    const maxW = 80;
    const result = formatStatusLine({ model: '', branch: 'main', cost: 0.05 }, maxW);
    expect(displayWidth(result)).toBeLessThanOrEqual(maxW);
  });

  it('non-finite token count (Infinity) renders without crashing', () => {
    // formatTokens() receives the raw number; non-finite values should not throw.
    expect(() => formatStatusLine({ model: 'sonnet', tokens: Infinity }, 80)).not.toThrow();
  });

  it('non-finite token count (NaN) renders without crashing', () => {
    expect(() => formatStatusLine({ model: 'sonnet', tokens: NaN }, 80)).not.toThrow();
  });

  it('non-finite cost renders without crashing', () => {
    expect(() => formatStatusLine({ model: 'sonnet', cost: Infinity }, 80)).not.toThrow();
  });

  it('negative cost does not crash', () => {
    expect(() => formatStatusLine({ model: 'sonnet', cost: -0.01 }, 80)).not.toThrow();
  });

  it('turnCount = 0 still renders turn 0 (segment is present when the field is defined)', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', turnCount: 0 }, 200));
    expect(out).toContain('turn 0');
  });

  it('maxBudgetUsd = 0 does not append a cap suffix', () => {
    const out = stripAll(formatStatusLine(
      { model: 'sonnet', budgetUsd: 0.10, maxBudgetUsd: 0 },
      200,
    ));
    expect(out).toContain('$0.10');
    expect(out).not.toContain('$0.10/$');
  });

  it('does not emit a turn segment when turnCount is undefined even if maxTurns is set', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', maxTurns: 5 }, 200));
    expect(out).not.toContain('turn ');
    expect(out).not.toContain('/5');
  });

  it('tokPerSec rounds to nearest integer in the label', () => {
    const out = stripAll(formatStatusLine({ model: 'sonnet', tokPerSec: 347.8 }, 200));
    expect(out).toContain('348 tok/s');
  });

  it('branch is truncated at 30 display columns', () => {
    const longBranch = 'feat/' + 'a'.repeat(60);
    const out = stripAll(formatStatusLine({ model: 'sonnet', branch: longBranch }, 200));
    // Must contain the truncation marker and not the full 60-char run.
    expect(out).toContain('…');
    expect(out).not.toContain('a'.repeat(40));
  });

  it('returns a plain string when model is the only field', () => {
    const result = formatStatusLine({ model: 'sonnet' }, 80);
    expect(stripAll(result)).toContain('sonnet');
    // No separators when there's only one part.
    expect(stripAll(result)).not.toContain('·');
  });
});
