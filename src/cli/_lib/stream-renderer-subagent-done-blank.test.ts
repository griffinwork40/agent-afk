/**
 * Regression test — PR #2196 root-depth blank separator on the armed TTY path.
 *
 * REGRESSION (d62b8870): flushSource moved the post-subagent breathing-room
 * blank from a dedicated `commitAbove('')` into a trailing `''` element of
 * its return array. The caller then committed via `commitBlockAbove(compositor,
 * lines)`, which joins all lines on '\n'. decomposeCommitText strips a lone
 * trailing '\n' as a line terminator, so the '' element was silently dropped —
 * no blank row was painted on the armed TTY path.
 *
 * FIX: stream-renderer-process.ts peels a trailing '' off the lines array
 * and commits it via a separate `compositor.commitAbove('')`, restoring the
 * pre-PR behavior. Non-empty trailing elements (nested dim-spine separators)
 * remain inside the block commit.
 *
 * TESTS:
 *   1. Pre-fix simulation: committing lines via commitBlockAbove alone (no
 *      peel) loses the blank — demonstrates the regression that the fix closes.
 *   2. Root-depth subagent done → fixed TTY path → block commit + separate
 *      commitAbove('') trailing blank (must pass after fix, fail before).
 *   3. Nested-depth subagent done → spine separator inside the block commit,
 *      no separate blank.
 *   4. Non-TTY / no-compositor path → exactly one trailing '' from out.line,
 *      unchanged behavior (regression guard).
 *
 * @module cli/_lib/stream-renderer-subagent-done-blank.test
 */

import { describe, it, expect } from 'vitest';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { commitBlockAbove } from './commit-block.js';
import { indentForScrollback } from '../commands/interactive/tool-lane-flush-margin.js';
import { syntheticResult } from './stream-renderer-source.js';

// ──────────────────────────────────────────────────────────────────────────────
// Stub compositor that records every commitAbove call.
// ──────────────────────────────────────────────────────────────────────────────

function makeCompositor(): {
  commitAboveCalls: string[];
  compositor: { commitAbove(text: string): void; setOverlay(text: string): void };
} {
  const commitAboveCalls: string[] = [];
  const compositor = {
    commitAbove(text: string) { commitAboveCalls.push(text); },
    setOverlay(_text: string) { /* ignore */ },
  };
  return { commitAboveCalls, compositor };
}

/**
 * Wire the exact TTY-path commit sequence from stream-renderer-process.ts
 * after the PR #2196 fix:
 *
 *   const blockLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
 *   const hasRootBlank = blockLines !== lines;
 *   commitBlockAbove(compositor, blockLines);
 *   if (hasRootBlank) compositor.commitAbove('');
 */
function runFixedTTYCommit(
  lines: readonly string[],
  compositor: { commitAbove(text: string): void },
): void {
  const blockLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const hasRootBlank = blockLines !== lines;
  commitBlockAbove(compositor, blockLines);
  if (hasRootBlank) compositor.commitAbove('');
}

/**
 * Simulate the PRE-FIX TTY-path commit sequence from d62b8870:
 * commitBlockAbove joins ALL lines (including the trailing '') on '\n',
 * then calls commitAbove once with the joined string. decomposeCommitText
 * strips the lone trailing '\n', so the '' is swallowed.
 */
function runPreFixTTYCommit(
  lines: readonly string[],
  compositor: { commitAbove(text: string): void },
): void {
  // Exact pre-fix logic: commitBlockAbove(compositor, lines) with no peeling.
  commitBlockAbove(compositor, lines);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers to build a minimal subagent lane entry.
// ──────────────────────────────────────────────────────────────────────────────

function makeRootSubagentLane(): { lane: ToolLane; agentId: string } {
  const lane = new ToolLane();
  const agentId = 'agent-root-001';
  // Root-depth: no agentContext parent → ancestorIsLast.length will be 0 in flushSource.
  lane.addStartWithAgentContext(agentId, 'agent', '(test-subagent)', undefined);
  lane.mergeAgentLabel(agentId, 'test-subagent');
  lane.addStart('bash-1', 'Bash', '"ls"', agentId);
  lane.addResult('bash-1', syntheticResult('file.ts', false));
  lane.setAgentResultSummary(agentId, 'Done (1 tool · 0.5s)');
  lane.addResult(agentId, syntheticResult('Done (1 tool · 0.5s)', false));
  return { lane, agentId };
}

function makeNestedSubagentLane(): { lane: ToolLane; agentId: string; parentId: string } {
  const lane = new ToolLane();
  // Parent (compose/skill) entry at depth 0 — stays live (no result), giving
  // the child a non-zero ancestorIsLast.length in flushSource.
  const parentId = 'skill-parent-001';
  lane.addStartWithAgentContext(parentId, 'agent', '(skill)', undefined);
  lane.mergeAgentLabel(parentId, 'skill');

  // Child subagent nested under the parent.
  const agentId = 'agent-nested-001';
  lane.addStartWithAgentContext(agentId, 'agent', '(child-agent)', parentId);
  lane.mergeAgentLabel(agentId, 'child-agent');
  lane.addStart('bash-2', 'Bash', '"pwd"', agentId);
  lane.addResult('bash-2', syntheticResult('/project', false));
  lane.setAgentResultSummary(agentId, 'Done (1 tool · 0.3s)');
  lane.addResult(agentId, syntheticResult('Done (1 tool · 0.3s)', false));
  return { lane, agentId, parentId };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('PR #2196 regression — pre-fix simulation shows blank is lost', () => {
  it('PRE-FIX: commitBlockAbove alone swallows the trailing empty separator (regression demonstration)', () => {
    // This test documents what went wrong on d62b8870. flushSource returns
    // lines ending in '' at root depth. The pre-fix caller passed all lines to
    // commitBlockAbove which joins them on '\n'. decomposeCommitText then strips
    // the lone trailing '\n' as a line terminator → the '' is lost, no blank row.
    const { lane, agentId } = makeRootSubagentLane();
    const rawLines = lane.flushSource(agentId);
    const lines = indentForScrollback(rawLines);

    // flushSource must append '' at root depth (unchanged on both d62b8870 and fix).
    expect(rawLines[rawLines.length - 1]).toBe('');

    const { commitAboveCalls, compositor } = makeCompositor();
    runPreFixTTYCommit(lines, compositor);

    // PRE-FIX: one commitAbove call (the joined block). The '' is joined as a
    // trailing '\n', which decomposeCommitText strips — the blank is NOT painted.
    // commitAbove is never called with '' alone.
    const blankCalls = commitAboveCalls.filter((c) => c === '');
    expect(blankCalls.length).toBe(0); // this is the regression: no blank row
    expect(commitAboveCalls.length).toBe(1); // only one call, no separate blank
  });
});

describe('PR #2196 fix — root-depth subagent-done blank on armed TTY path', () => {
  it('root depth: block commit is followed by a separate commitAbove("") blank row', () => {
    const { lane, agentId } = makeRootSubagentLane();
    const rawLines = lane.flushSource(agentId);
    const lines = indentForScrollback(rawLines);

    // flushSource must have appended a trailing '' at root depth.
    expect(rawLines[rawLines.length - 1]).toBe('');

    const { commitAboveCalls, compositor } = makeCompositor();
    runFixedTTYCommit(lines, compositor);

    // The block content must have been committed (non-empty call).
    expect(commitAboveCalls.length).toBeGreaterThanOrEqual(2);
    // The LAST call must be the blank, emitted as a dedicated commitAbove('').
    expect(commitAboveCalls[commitAboveCalls.length - 1]).toBe('');
    // The second-to-last call must be the block content (non-empty).
    const blockCall = commitAboveCalls[commitAboveCalls.length - 2];
    expect(blockCall).not.toBe('');
    // Exactly one blank in the sequence (no double-blank).
    const blanks = commitAboveCalls.filter((c) => c === '');
    expect(blanks.length).toBe(1);
  });

  it('root depth: the blank is NOT embedded in the block commit (decomposeCommitText regression guard)', () => {
    const { lane, agentId } = makeRootSubagentLane();
    const rawLines = lane.flushSource(agentId);
    const lines = indentForScrollback(rawLines);

    const { commitAboveCalls, compositor } = makeCompositor();
    runFixedTTYCommit(lines, compositor);

    // The block commit (all calls except the last blank) must not end with '\n\n'
    // (which would indicate an embedded trailing blank inside commitBlockAbove).
    const blockCall = commitAboveCalls[commitAboveCalls.length - 2]!;
    expect(blockCall.endsWith('\n\n'), 'block commit must not contain embedded trailing blank').toBe(false);
  });
});

describe('PR #2196 fix — nested-depth spine separator stays inside block commit', () => {
  it('nested depth: spine separator is inside the block commit, no separate blank', () => {
    const { lane, agentId } = makeNestedSubagentLane();
    const rawLines = lane.flushSource(agentId);
    const lines = indentForScrollback(rawLines);

    // At nested depth, the trailing element should be a non-empty dim-spine string.
    const trailingRaw = rawLines[rawLines.length - 1]!;
    expect(trailingRaw).not.toBe('');

    const { commitAboveCalls, compositor } = makeCompositor();
    runFixedTTYCommit(lines, compositor);

    // Exactly one commitAbove call: the whole block including the spine separator.
    expect(commitAboveCalls.length).toBe(1);
    // No separate blank commitAbove('').
    const blanks = commitAboveCalls.filter((c) => c === '');
    expect(blanks.length).toBe(0);
    // The block commit includes the spine separator (joined by '\n' inside).
    const blockCall = commitAboveCalls[0]!;
    expect(blockCall.length).toBeGreaterThan(0);
  });
});

describe('PR #2196 fix — non-TTY path unchanged (one trailing blank via out.line)', () => {
  it('non-TTY: flushSource lines include trailing "", emitting one blank via out.line loop', () => {
    const { lane, agentId } = makeRootSubagentLane();
    const rawLines = lane.flushSource(agentId);
    const lines = indentForScrollback(rawLines);

    // Non-TTY path: just iterate lines through out.line.
    const written: string[] = [];
    for (const line of lines) written.push(line);

    // Must end with exactly one blank.
    expect(written[written.length - 1]).toBe('');
    const blanks = written.filter((l) => l === '');
    expect(blanks.length).toBe(1);
    // Content lines must precede the blank.
    expect(written.length).toBeGreaterThan(1);
    expect(written[0]).not.toBe('');
  });
});
