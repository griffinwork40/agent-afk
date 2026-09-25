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
 * All assertions go through the REAL production caller: `processEvent` via
 * `StreamRenderer.process()`, following the same pattern used in
 * rhythm-contract.test.ts — `forceNonTty: true` with a stub compositor
 * injected via private-field cast so the TTY branch fires without a real PTY.
 *
 * TESTS:
 *   (a) Root-depth subagent done → block commit + exactly one separate
 *       commitAbove('') (must FAIL on d62b8870, PASS on fix).
 *   (b) Nested-depth subagent done → spine separator is inside the block
 *       commit, no separate blank commitAbove('').
 *   (c) No-compositor path (isTTY, compositor null) → exactly one trailing ''
 *       from out.line, unchanged behavior.
 *
 * @module cli/_lib/stream-renderer-subagent-done-blank.test
 */

import { describe, it, expect } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import type { Writer } from '../slash/types.js';
import type { OutputEvent, SubagentProgressMeta } from '../../agent/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Stub compositor that records every commitAbove call.
// Mirrors the pattern in rhythm-contract.test.ts (TTY safety-net tests).
// ──────────────────────────────────────────────────────────────────────────────

function makeCompositor(): {
  commitAboveCalls: string[];
  compositor: {
    commitAbove(text: string): void;
    setOverlay(text: string): void;
    setSpinner(cfg: { enabled: boolean }): void;
    arm(): Promise<void>;
    disarm(): void;
    getBuffer(): { text: string; queued: boolean };
    isArmed(): boolean;
  };
} {
  const commitAboveCalls: string[] = [];
  const compositor = {
    commitAbove(text: string) { commitAboveCalls.push(text); },
    setOverlay(_text: string) { /* ignore */ },
    setSpinner(_cfg: { enabled: boolean }) { /* ignore */ },
    arm: async () => {},
    disarm: () => {},
    getBuffer: () => ({ text: '', queued: false }),
    isArmed: () => true,
  };
  return { commitAboveCalls, compositor };
}

function makeWriter(): { writer: Writer; lines: string[] } {
  const lines: string[] = [];
  const writer: Writer = {
    line(text = '') { lines.push(text); },
    raw(text) { lines.push(text); },
    success(text) { lines.push('SUCCESS:' + text); },
    info(text) { lines.push('INFO:' + text); },
    warn(text) { lines.push('WARN:' + text); },
    error(text) { lines.push('ERROR:' + text); },
  };
  return { writer, lines };
}

/** Private fields of StreamRenderer that we need to patch for TTY simulation. */
type PrivateRenderer = {
  isTTY: boolean;
  compositor: ReturnType<typeof makeCompositor>['compositor'];
  streamingMarkdownRef: { current: null };
};

function contentEvent(chunk = 'hello'): OutputEvent {
  return { type: 'chunk', chunk: { type: 'content', content: chunk } };
}

function doneEvent(): OutputEvent {
  return { type: 'done' };
}

function subagentMeta(
  subagentId: string,
  opts: { agentType?: string; parentId?: string } = {},
): SubagentProgressMeta {
  return { subagentId, ...opts };
}

/**
 * Drive a subagent to completion through the real processEvent TTY path.
 * Returns the commitAboveCalls recorded by the stub compositor.
 *
 * Pattern (identical to rhythm-contract.test.ts TTY safety-net tests):
 *   1. Create StreamRenderer with forceNonTty (no real PTY needed).
 *   2. Patch isTTY=true + stub compositor via private-field cast.
 *   3. Feed events: first-event (creates source) → done (triggers flush+drain).
 *   4. drainSubagent inside processEvent fires the scheduled commit closure
 *      synchronously, recording all commitAbove calls.
 */
async function driveSubagentDone(
  subagentId: string,
  opts: { parentId?: string; agentType?: string } = {},
): Promise<{ commitAboveCalls: string[]; lines: string[] }> {
  const { writer, lines } = makeWriter();
  const { commitAboveCalls, compositor } = makeCompositor();

  const r = new StreamRenderer({ out: writer, forceNonTty: true });
  const privateR = r as unknown as PrivateRenderer;
  privateR.isTTY = true;
  privateR.compositor = compositor;
  privateR.streamingMarkdownRef.current = null;

  const meta = subagentMeta(subagentId, opts);

  // First event: registers source + synthesizes agent entry in toolLane.
  r.process(contentEvent(), meta);
  // Done event: triggers the TTY flush + schedules commit batch + drainSubagent.
  r.process(doneEvent(), meta);

  await r.dispose();

  return { commitAboveCalls, lines };
}

// ──────────────────────────────────────────────────────────────────────────────
// (a) Root-depth subagent done: block commit + exactly one separate
//     commitAbove('').
// This test MUST FAIL on d62b8870's stream-renderer-process.ts and PASS after
// the PR #2196 fix.
// ──────────────────────────────────────────────────────────────────────────────

describe('PR #2196 fix — (a) root-depth subagent-done blank on armed TTY path', () => {
  it('root depth: block commit is followed by exactly one separate commitAbove("") blank row', async () => {
    const { commitAboveCalls } = await driveSubagentDone('agent-root-001', {
      agentType: 'test-agent',
    });

    // At least two commits: the block content plus the trailing blank.
    expect(commitAboveCalls.length, 'expected at least block commit + blank commit').toBeGreaterThanOrEqual(2);

    // The LAST call must be the blank, emitted as a dedicated commitAbove('').
    expect(
      commitAboveCalls[commitAboveCalls.length - 1],
      'last commitAbove must be the blank separator',
    ).toBe('');

    // The second-to-last must be the block content (non-empty).
    const blockCall = commitAboveCalls[commitAboveCalls.length - 2]!;
    expect(blockCall, 'second-to-last commitAbove must be block content (non-empty)').not.toBe('');

    // Exactly ONE blank in the whole sequence (no double-blank).
    const blanks = commitAboveCalls.filter((c) => c === '');
    expect(blanks.length, 'exactly one separate blank commitAbove call').toBe(1);
  });

  it('root depth: blank is NOT embedded inside the block commit (decomposeCommitText regression guard)', async () => {
    const { commitAboveCalls } = await driveSubagentDone('agent-root-002', {
      agentType: 'test-agent',
    });

    // The block commit (all calls except the last blank) must not end with '\n\n',
    // which would indicate an embedded trailing blank inside commitBlockAbove.
    const blockCall = commitAboveCalls[commitAboveCalls.length - 2]!;
    expect(
      blockCall.endsWith('\n\n'),
      'block commit must not contain embedded trailing blank',
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// (b) Nested-depth subagent done: spine separator inside the block commit,
//     no separate blank.
// ──────────────────────────────────────────────────────────────────────────────

describe('PR #2196 fix — (b) nested-depth subagent-done: spine separator inside block', () => {
  it('nested depth: all commits are block content (spine separator included), no separate blank', async () => {
    // Send the parent agent first so the nesting depth resolves correctly.
    // We drive a fresh renderer for the parent, then another for the child,
    // OR we drive both through the same renderer so the parentId resolves.
    const { writer, lines: _lines } = makeWriter();
    const { commitAboveCalls, compositor } = makeCompositor();

    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = compositor;
    privateR.streamingMarkdownRef.current = null;

    // Register the parent subagent (stays live — no doneEvent for it).
    const parentMeta = subagentMeta('parent-skill-001', { agentType: 'skill' });
    r.process(contentEvent('parent output'), parentMeta);

    // Drive the child to done while the parent is still live.
    const childMeta = subagentMeta('child-agent-001', {
      agentType: 'child',
      parentId: 'parent-skill-001',
    });
    r.process(contentEvent('child output'), childMeta);
    r.process(doneEvent(), childMeta);

    await r.dispose();

    // There must be some commitAbove calls (the child's block).
    // (If the parent is still live the child could be nested — the trailing
    // separator is a non-empty dim-spine string, NOT ''.)
    //
    // The child's block commits: find the last blank and verify no standalone blank.
    const blankCalls = commitAboveCalls.filter((c) => c === '');
    // At nested depth the trailing element is a dim-spine string (not ''),
    // so no separate blank commitAbove('') should fire for the child.
    expect(
      blankCalls.length,
      `nested child: expected 0 separate blank commits, got ${blankCalls.length} (commitAboveCalls=${JSON.stringify(commitAboveCalls)})`,
    ).toBe(0);

    // At least one commit for the child block.
    expect(commitAboveCalls.length, 'nested child block must produce at least one commit').toBeGreaterThanOrEqual(1);

    // None of the block commits should be an empty string.
    for (const call of commitAboveCalls) {
      expect(call, `commit '${call}' should not be a standalone blank at nested depth`).not.toBe('');
    }

    // Positive claim: the child's block commit ends with the dim-spine
    // separator row (the ancestor's `│` column), inside the same commit.
    const stripAnsi = (t: string): string => t.replace(/\x1b\[[0-9;]*m/g, '');
    const lastRow = stripAnsi(commitAboveCalls[commitAboveCalls.length - 1]!).split('\n').pop();
    expect(lastRow?.trimEnd(), 'nested child block must end with the ancestor spine separator').toMatch(/│$/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// (c) No-compositor path (isTTY, compositor null): exactly one trailing ''
//     from out.line.
// ──────────────────────────────────────────────────────────────────────────────

describe('PR #2196 fix — (c) no-compositor path: one trailing blank via out.line', () => {
  it('no-compositor: subagent done emits tool lines then exactly one trailing "" via out.line', async () => {
    const { writer, lines } = makeWriter();
    // isTTY=true reaches the `if (isTerminal && ctx.isTTY)` flushSource branch;
    // a null compositor routes the commit closure to its `out.line` loop.
    // (forceNonTty alone skips the flushSource branch entirely.)
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.streamingMarkdownRef.current = null;

    const meta = subagentMeta('agent-nontty-001', { agentType: 'test-agent' });
    r.process(contentEvent('some work'), meta);
    r.process(doneEvent(), meta);

    await r.dispose();

    // The closure loops `for (const line of lines) out.line(line)`;
    // flushSource appends '' at root depth so out.line receives it last.
    expect(lines.length, 'no-compositor path must write the subagent block').toBeGreaterThanOrEqual(2);
    expect(lines[lines.length - 1], 'last written line must be the blank separator').toBe('');
    const blanks = lines.filter((l) => l === '');
    expect(blanks.length, 'exactly one trailing blank').toBe(1);
  });
});
