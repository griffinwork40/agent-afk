/**
 * Additional coverage tests for tool-lane-render-compact.ts.
 *
 * Covers gaps not addressed in tool-lane-render-compact.test.ts:
 *   4. formatAgentChildren compact-path discrimination (skill-1 has a live
 *      successful child that compact suppresses but non-compact shows).
 *   7a. ancestorIsLast indentation: [false] → spine '│' present; [true] → absent.
 *   7b. Benign-error doneGlyph: ⊘ present and ✗ absent for permission-denied.
 *   7c. Narrow-cols clamping: every emitted line fits within cols.
 *   7d. Multi-line outcome continuation: two pushOutcomeLines rows emitted.
 */

import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../../display.js';
import { freshToolEntry } from './tool-lane-render.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import type { ToolFailureClass } from '../../../agent/trace/types.js';
import { ToolLane } from './tool-lane.js';

// ── Shared fixture helpers ─────────────────────────────────────────────────────

function makeResult(
  content: string,
  isError = false,
  failureClass?: ToolFailureClass,
): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'unused',
    content,
    isError,
    ...(failureClass ? { failureClass } : {}),
  };
}

function makeTool(toolUseId: string, toolName: string, toolInput: string, result?: ToolResultChunk) {
  const entry = freshToolEntry(toolUseId, toolName, toolInput, toolName + toolInput);
  if (result) entry.result = result;
  return entry;
}

// ── 4. formatAgentChildren compact-path discrimination ─────────────────────────

describe('formatAgentChildren compact-path discrimination (item 4)', () => {
  it('compact=true suppresses a live successful direct child of skill; compact=false shows it', () => {
    // Set up compact lane: skill-1 has agent-a (flushed) + tool-b (successful, not flushed).
    // After flushSource emits agent-a eagerly, flush() runs formatAgentChildren for skill-1.
    // compact=true → renderCompactFlushChildren → tool-b suppressed.
    // compact=false → renderFlushChildren → tool-b visible.

    function buildLane(compact: boolean): string {
      const lane = new ToolLane();
      lane.compactScrollback = compact;

      lane.addStartWithAgentContext('skill-1', 'skill', '(review)', undefined);
      // First child: agent-a (nesting tool), will be eagerly emitted via flushSource
      lane.addStartWithAgentContext('agent-a', 'Agent', '(reviewer)', 'skill-1');
      lane.addStartWithAgentContext('t1', 'Read', '("code.ts")', 'agent-a');
      lane.addResult('t1', makeResult('55 lines'));
      lane.setAgentResultSummary('agent-a', 'Done (1 tool · 1.0s)');
      lane.addResult('agent-a', makeResult('done'));
      // Eagerly commit agent-a (sets headerEmitted on skill-1)
      lane.flushSource('agent-a');

      // Second child: tool-b (leaf tool) directly under skill-1 — successful
      lane.addStartWithAgentContext('tool-b', 'Grep', '("TODO")', 'skill-1');
      lane.addResult('tool-b', makeResult('2 matches'));

      // skill-1 completes
      lane.setAgentResultSummary('skill-1', 'Done (1 subagent · 2.0s)');
      lane.addResult('skill-1', makeResult('done'));

      const lines = lane.flush();
      return stripAnsi(lines.join('\n'));
    }

    const compactOut = buildLane(true);
    const fullOut = buildLane(false);

    // Compact: the successful Grep child (tool-b) must be suppressed
    expect(compactOut).not.toContain('Grep');
    expect(compactOut).toContain('Done (1 subagent · 2.0s)');

    // Full: the Grep child must appear (non-compact renders all children)
    expect(fullOut).toContain('Grep');
    expect(fullOut).toContain('Done (1 subagent · 2.0s)');
  });
});

// ── 7a. ancestorIsLast indentation ────────────────────────────────────────────

describe('ancestorIsLast indentation (item 7a)', () => {
  it('ancestorIsLast=[false] → spine │ present in output (ancestor has more siblings)', async () => {
    const { renderCompactFlushChildren } = await import('./tool-lane-render-compact.js');

    const errChild = makeTool('e1', 'Bash', '("cmd")', makeResult('fail', true));
    const lines = renderCompactFlushChildren(
      [errChild],
      new Map(),
      undefined,
      'Done (1 tool)',
      120,
      [false], // ancestor is NOT the last sibling → spine │ should appear
    );

    const stripped = lines.map((l) => stripAnsi(l)).join('\n');
    // buildIndent with ancestorIsLast=[false] produces g.spine ('│  ') for the
    // ancestor slot, so the output indent column should contain '│'.
    expect(stripped).toContain('│');
  });

  it('ancestorIsLast=[true] → ancestor spine column is spaces (not │), visible in indent prefix', async () => {
    const { renderCompactFlushChildren } = await import('./tool-lane-render-compact.js');

    const errChild = makeTool('e2', 'Bash', '("cmd")', makeResult('fail', true));

    // ancestorIsLast=[false]: ancestor slot → g.spine ('│  ') → first char is '│'
    const linesNotLast = renderCompactFlushChildren(
      [errChild],
      new Map(),
      undefined,
      'Done (1 tool)',
      120,
      [false],
    );
    // ancestorIsLast=[true]: ancestor slot → g.spineClosed ('   ') → first char is ' '
    const linesIsLast = renderCompactFlushChildren(
      [makeTool('e3', 'Bash', '("cmd")', makeResult('fail', true))],
      new Map(),
      undefined,
      'Done (1 tool)',
      120,
      [true],
    );

    // [false]: buildIndent produces '│  │  ' — ancestor column starts with '│'
    // [true]:  buildIndent produces '   │  ' — ancestor column is spaces
    const firstCharNotLast = stripAnsi(linesNotLast[0]!)[0];
    const firstCharIsLast  = stripAnsi(linesIsLast[0]!)[0];

    expect(firstCharNotLast).toBe('│');  // ancestor slot open spine
    expect(firstCharIsLast).toBe(' ');  // ancestor slot closed (spaces)
  });
});

// ── 7b. Benign-error doneGlyph: ⊘ present, ✗ absent ─────────────────────────

describe('benign-error doneGlyph (item 7b)', () => {
  it('permission-denied failureClass → ⊘ glyph present, ✗ glyph absent', async () => {
    const { renderCompactFlushChildren } = await import('./tool-lane-render-compact.js');

    // permission-denied is in BENIGN_FAILURE_CLASSES → doneGlyph returns ⊘
    const benignChild = makeTool(
      'b1',
      'Bash',
      '("restricted")',
      makeResult('Permission denied', true, 'permission-denied'),
    );

    const lines = renderCompactFlushChildren(
      [benignChild],
      new Map(),
      undefined,
      'Done (1 tool)',
    );

    const stripped = lines.map((l) => stripAnsi(l)).join('\n');
    // Benign failures render with ⊘ (statusBadge('blocked')) not ✗
    expect(stripped).toContain('⊘');
    expect(stripped).not.toContain('✗');
  });

  it('non-benign error (no failureClass) → ✗ glyph present, ⊘ absent', async () => {
    const { renderCompactFlushChildren } = await import('./tool-lane-render-compact.js');

    const errChild = makeTool('e1', 'Bash', '("bad")', makeResult('EPERM', true));

    const lines = renderCompactFlushChildren(
      [errChild],
      new Map(),
      undefined,
      'Done (1 tool)',
    );

    const stripped = lines.map((l) => stripAnsi(l)).join('\n');
    expect(stripped).toContain('✗');
    expect(stripped).not.toContain('⊘');
  });
});

// ── 7c. Narrow-cols clamping ──────────────────────────────────────────────────

describe('narrow-cols clamping (item 7c)', () => {
  it('every emitted line display-width <= cols for a very narrow cols with long content', async () => {
    const { renderCompactFlushChildren } = await import('./tool-lane-render-compact.js');
    const { displayWidth } = await import('../../display.js');

    const cols = 40; // narrow
    const longContent = 'x'.repeat(200); // much wider than 40 cols
    const errChild = makeTool('e1', 'Bash', '("cmd")', makeResult(longContent, true));

    const lines = renderCompactFlushChildren(
      [errChild],
      new Map(),
      undefined,
      'Done (1 tool)',
      cols,
    );

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const w = displayWidth(stripAnsi(line));
      expect(w).toBeLessThanOrEqual(cols);
    }
  });
});

// ── 7d. Multi-line outcome continuation ───────────────────────────────────────

describe('multi-line outcome continuation (item 7d)', () => {
  it('multi-line output (lineCount + tailPreview) → continuation rows emitted by pushOutcomeLines', async () => {
    const { renderCompactFlushChildren } = await import('./tool-lane-render-compact.js');

    // formatOutcome enters the multi-line branch when lineCount > 1.
    // It appends tailPreview lines joined by '\n', which pushOutcomeLines
    // then splits so each tail line becomes a separate emitted row with
    // the continuationIndent (spine-only prefix, no connector).
    const multiLineResult: ToolResultChunk = {
      type: 'tool_result',
      toolUseId: 'unused',
      content: '3 lines of output',
      isError: true,
      lineCount: 3,
      tailPreview: ['line A', 'line B'],
    };
    const errChild = makeTool('e1', 'Bash', '("cmd")', multiLineResult);

    const lines = renderCompactFlushChildren(
      [errChild],
      new Map(),
      undefined,
      'Done (1 tool)',
      200, // wide enough to not clamp
    );

    // Expected output rows:
    //   1. Error child head row:  ├─ prefix + "3 lines · …"
    //   2. Continuation row:      spine indent + "line A"
    //   3. Continuation row:      spine indent + "line B"
    //   4. Done summary:          ╰─ prefix + summary text
    expect(lines.length).toBeGreaterThanOrEqual(4);

    // The continuation rows (rows 2, 3) should NOT contain ├─ or ╰─ (connector-only on head row)
    const connectorLines = lines.filter((l) => stripAnsi(l).match(/[├╰]/));
    // Head row (error child) + summary row = 2 connector lines
    expect(connectorLines).toHaveLength(2);

    // The tail preview content should appear somewhere in the output
    const joined = lines.map((l) => stripAnsi(l)).join('\n');
    expect(joined).toContain('line A');
    expect(joined).toContain('line B');
  });
});
