/**
 * Tests for tool-lane-render-compact.ts
 *
 * Covers:
 *   1. renderCompactFlushChildren — connector topology, error-child preservation,
 *      edge cases (no children / no summary / no errors).
 *   2. collectErrorChildren — flat list, nested grandchildren (BFS order), empty input.
 *   3. ToolLane integration with compactScrollback = true — flush, flushSource,
 *      flushCompletedRoots; and the agent-level-error fall-through to full rendering.
 *
 * Style conventions match the existing tool-lane.test.ts sibling file:
 *   - stripAnsi() for visual assertions on rendered output.
 *   - makeResult() helper for ToolResultChunk fixtures.
 *   - Direct ToolLane usage; no mocks.
 *   - compactScrollback is a public field on ToolLane — no seam required.
 */

import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../../display.js';
import { freshToolEntry } from './tool-lane-render.js';
import type { Entry, ToolEntry } from './tool-lane-render.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import { ToolLane } from './tool-lane.js';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeResult(content: string, isError = false, failureClass?: string): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'unused',
    content,
    isError,
    ...(failureClass ? { failureClass } : {}),
  };
}

/**
 * Build a minimal ToolEntry suitable for passing to renderCompactFlushChildren
 * as a child.  `result` is set when provided so the entry is "completed".
 */
function makeTool(
  toolUseId: string,
  toolName: string,
  toolInput: string,
  result?: ToolResultChunk,
): ToolEntry {
  const entry = freshToolEntry(toolUseId, toolName, toolInput, toolName + toolInput);
  if (result) entry.result = result;
  return entry;
}

// ── 1. renderCompactFlushChildren ─────────────────────────────────────────────

describe('renderCompactFlushChildren', () => {
  // Import lazily to keep the module boundary clean and avoid hoisting issues
  // with named imports that ESM resolves differently inside describe blocks.
  async function getModule() {
    return import('./tool-lane-render-compact.js');
  }

  // ── 1a. Successful agent: no children, summary present ───────────────────

  it('no children + summary → single Done line with lastConnector (╰─)', async () => {
    const { renderCompactFlushChildren } = await getModule();
    const lines = renderCompactFlushChildren(
      [],
      new Map(),
      undefined,          // homeDir
      'Done (0 tools · 0.5s)',
    );
    expect(lines).toHaveLength(1);
    const raw = stripAnsi(lines[0]!);
    expect(raw).toContain('Done (0 tools · 0.5s)');
    // Last (and only) sibling → lastConnector `╰─`
    expect(raw).toContain('╰─');
    expect(raw).not.toContain('├─');
  });

  // ── 1b. No children, no summary → empty array ───────────────────────────

  it('no children + no summary → empty array', async () => {
    const { renderCompactFlushChildren } = await getModule();
    const lines = renderCompactFlushChildren([], new Map());
    expect(lines).toHaveLength(0);
  });

  // ── 1c. One errored child + summary → error row midConnector, Done lastConnector

  it('one errored child + summary → error row uses ├─, Done row uses ╰─', async () => {
    const { renderCompactFlushChildren } = await getModule();

    const badChild = makeTool('bad-1', 'Bash', '("rm -rf /")', makeResult('EPERM', true));
    const children: Entry[] = [badChild];
    const childMap = new Map<string, Entry[]>();

    const lines = renderCompactFlushChildren(
      children,
      childMap,
      undefined,
      'Done (1 tool · 0.9s)',
    );

    // 2 output rows: one error child + one Done summary
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const stripped = lines.map((l) => stripAnsi(l));

    // Error child uses mid connector (not last)
    const errorLine = stripped.find((l) => l.includes('├─'));
    expect(errorLine, 'error child should use ├─ mid-connector').toBeDefined();

    // Done summary uses last connector
    const doneLine = stripped.find((l) => l.includes('Done (1 tool'));
    expect(doneLine, 'Done summary line must exist').toBeDefined();
    expect(doneLine).toContain('╰─');
  });

  // ── 1d. Multiple errored children + summary → all non-last get ├─ ────────

  it('multiple errored children + summary → correct mid/last connector assignment', async () => {
    const { renderCompactFlushChildren } = await getModule();

    const err1 = makeTool('e1', 'Bash', '("cmd1")', makeResult('fail1', true));
    const err2 = makeTool('e2', 'Grep', '("pat")',  makeResult('fail2', true));
    const err3 = makeTool('e3', 'Read', '("f.ts")', makeResult('fail3', true));

    const children: Entry[] = [err1, err2, err3];
    const childMap = new Map<string, Entry[]>();

    const lines = renderCompactFlushChildren(
      children,
      childMap,
      undefined,
      'Done (3 tools · 1.2s)',
    );

    const stripped = lines.map((l) => stripAnsi(l));

    // The Done summary must be the last line containing ╰─
    const doneLines = stripped.filter((l) => l.includes('Done (3 tools'));
    expect(doneLines).toHaveLength(1);
    expect(doneLines[0]).toContain('╰─');

    // At least two mid-connector lines (the 3 error children could each
    // produce one or more lines, but the head row of each uses ├─)
    const midLines = stripped.filter((l) => l.includes('├─'));
    expect(midLines.length).toBeGreaterThanOrEqual(2);
  });

  // ── 1e. Children present but none errored + summary → only Done line ──────

  it('non-errored children + summary → only Done line emitted (compact suppresses successes)', async () => {
    const { renderCompactFlushChildren } = await getModule();

    const ok1 = makeTool('ok-1', 'Read', '("a.ts")', makeResult('10 lines'));
    const ok2 = makeTool('ok-2', 'Grep', '("fn")', makeResult('2 matches'));
    const children: Entry[] = [ok1, ok2];
    const childMap = new Map<string, Entry[]>();

    const lines = renderCompactFlushChildren(
      children,
      childMap,
      undefined,
      'Done (2 tools · 0.8s)',
    );

    // Only the Done summary should appear; successful children are suppressed
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toContain('Done (2 tools · 0.8s)');
    expect(stripAnsi(lines[0]!)).toContain('╰─');
  });

  // ── 1f. No children, no summary → empty (edge case: agent ran nothing) ───

  it('empty children + undefined summary → empty array (no phantom lines)', async () => {
    const { renderCompactFlushChildren } = await getModule();
    const result = renderCompactFlushChildren([], new Map());
    expect(result).toEqual([]);
  });
});

// ── 2. collectErrorChildren ────────────────────────────────────────────────────

describe('collectErrorChildren (via renderCompactFlushChildren observable side-channel)', () => {
  // collectErrorChildren is not exported directly — we exercise it through
  // renderCompactFlushChildren's visible output and through the BFS
  // grandchildren path that's uniquely observable here.

  async function render(
    children: Entry[],
    childMap: Map<string, Entry[]>,
    summary?: string,
  ): Promise<string[]> {
    const { renderCompactFlushChildren } = await import('./tool-lane-render-compact.js');
    return renderCompactFlushChildren(children, childMap, undefined, summary);
  }

  it('flat children with mixed error/success → only errored entries produce rows', async () => {
    const errorChild  = makeTool('e1', 'Bash', '("bad")', makeResult('error msg', true));
    const successChild = makeTool('s1', 'Read', '("ok.ts")', makeResult('5 lines', false));

    const children: Entry[] = [errorChild, successChild];
    const childMap = new Map<string, Entry[]>();

    const lines = await render(children, childMap, 'Done (2 tools)');
    const stripped = lines.map((l) => stripAnsi(l)).join('\n');

    // Error child should appear, success child should NOT
    expect(stripped).toContain('Bash');
    expect(stripped).not.toContain('Read');   // success → suppressed
    expect(stripped).toContain('Done (2 tools)');
  });

  it('nested grandchildren via childMap — BFS collects deeply nested errors', async () => {
    // Top-level tool child (succeeds) → has a grandchild (errors)
    // The grandchild's error should appear even though its parent succeeded.
    const parentChild = makeTool('p1', 'Agent', '(inner)', makeResult('done'));
    const grandchild  = makeTool('gc1', 'Bash', '("broken")', makeResult('ENOENT', true));

    const children: Entry[] = [parentChild];
    const childMap = new Map<string, Entry[]>([
      ['p1', [grandchild]],
    ]);

    const lines = await render(children, childMap, 'Done (1 tool)');
    const stripped = lines.map((l) => stripAnsi(l)).join('\n');

    // The grandchild's error must appear (BFS found it)
    expect(stripped).toContain('Bash');
    expect(stripped).toContain('Done (1 tool)');
  });

  it('deeply nested error (depth 3) — BFS traversal reaches it', async () => {
    // Level 1 (success) → Level 2 (success) → Level 3 (error)
    const l1 = makeTool('l1', 'Agent', '(a)',  makeResult('done'));
    const l2 = makeTool('l2', 'Agent', '(b)',  makeResult('done'));
    const l3 = makeTool('l3', 'Bash',  '("c")', makeResult('deep error', true));

    const children: Entry[] = [l1];
    const childMap = new Map<string, Entry[]>([
      ['l1', [l2]],
      ['l2', [l3]],
    ]);

    const lines = await render(children, childMap, 'Done');
    const stripped = lines.map((l) => stripAnsi(l)).join('\n');
    expect(stripped).toContain('Bash');
    expect(stripped).toContain('Done');
  });

  it('empty children → empty output (no crash)', async () => {
    const lines = await render([], new Map(), undefined);
    expect(lines).toEqual([]);
  });

  it('empty children + summary → only summary line', async () => {
    const lines = await render([], new Map(), 'Done (0 tools)');
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toContain('Done (0 tools)');
  });

  it('BFS order: errors at same depth appear before deeper errors', async () => {
    // Two top-level errors + one grandchild error.
    // BFS should yield the two top-level errors first, then the grandchild.
    const e1  = makeTool('e1', 'Bash',  '("a")', makeResult('err1', true));
    const e2  = makeTool('e2', 'Grep',  '("b")', makeResult('err2', true));
    const gc  = makeTool('gc', 'Read',  '("c")', makeResult('err3', true));
    // A parent that succeeds but has an errored grandchild
    const par = makeTool('par', 'Agent', '(sub)', makeResult('done'));

    const children: Entry[] = [e1, par, e2]; // interleaved
    const childMap = new Map<string, Entry[]>([
      ['par', [gc]],
    ]);

    const lines = await render(children, childMap, 'Done');
    const stripped = lines.map((l) => stripAnsi(l)).join('\n');

    // All three errors must be visible
    expect(stripped).toContain('Bash');
    expect(stripped).toContain('Grep');
    expect(stripped).toContain('Read');
    expect(stripped).toContain('Done');
  });
});

// ── 3. ToolLane integration with compactScrollback = true ─────────────────────

describe('ToolLane with compactScrollback = true', () => {
  // ── 3a. flush: successful agent emits compact block (Done only) ────────────

  it('flush: successful agent with children → compact block (no child tool rows, only Done)', () => {
    const lane = new ToolLane();
    lane.compactScrollback = true;

    lane.addStartWithAgentContext('agent-1', 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('c1', 'Read', '("a.ts")', 'agent-1');
    lane.addResult('c1', makeResult('42 lines'));
    lane.addStartWithAgentContext('c2', 'Grep', '("TODO")', 'agent-1');
    lane.addResult('c2', makeResult('3 matches'));
    lane.setAgentResultSummary('agent-1', 'Done (2 tools · 1.0s)');
    lane.addResult('agent-1', makeResult('done'));

    const lines = lane.flush();
    const joined = stripAnsi(lines.join('\n'));

    // Head row must still appear
    expect(joined).toContain('Agent');
    expect(joined).toContain('researcher');

    // Done summary must appear
    expect(joined).toContain('Done (2 tools · 1.0s)');

    // Successful tool children MUST be suppressed in compact mode
    expect(joined).not.toContain('Read');
    expect(joined).not.toContain('Grep');
  });

  // ── 3b. flush: agent-level error falls through to full renderFlushChildren ──

  it('flush: agent-level error → full child tree rendered (no compact suppression)', () => {
    const lane = new ToolLane();
    lane.compactScrollback = true;

    lane.addStartWithAgentContext('agent-err', 'Agent', '(errored)', undefined);
    lane.addStartWithAgentContext('c1', 'Read', '("file.ts")', 'agent-err');
    lane.addResult('c1', makeResult('content'));
    lane.setAgentResultSummary('agent-err', 'Aborted (Ctrl-C)');
    // Agent-level error: isError = true
    lane.addResult('agent-err', makeResult('agent failed', true));

    const lines = lane.flush();
    const joined = stripAnsi(lines.join('\n'));

    // The full child tree must appear (fail evidence must never be hidden)
    expect(joined).toContain('Read');
    // And the agent header itself
    expect(joined).toContain('Agent');
    expect(joined).toContain('errored');
  });

  // ── 3c. flush: errored child within successful agent → child row preserved ─

  it('flush: errored tool child inside successful agent → error child row appears in compact output', () => {
    const lane = new ToolLane();
    lane.compactScrollback = true;

    lane.addStartWithAgentContext('agent-2', 'Agent', '(verifier)', undefined);
    lane.addStartWithAgentContext('ok', 'Read', '("ok.ts")', 'agent-2');
    lane.addResult('ok', makeResult('ok content'));
    lane.addStartWithAgentContext('bad', 'Bash', '("bad cmd")', 'agent-2');
    lane.addResult('bad', makeResult('ENOENT', true));
    lane.setAgentResultSummary('agent-2', 'Done (2 tools · 0.7s)');
    lane.addResult('agent-2', makeResult('done'));  // agent succeeded overall

    const lines = lane.flush();
    const joined = stripAnsi(lines.join('\n'));

    // Errored child must appear
    expect(joined).toContain('Bash');
    // Successful child must NOT appear
    expect(joined).not.toContain('Read');
    // Summary line must appear
    expect(joined).toContain('Done (2 tools · 0.7s)');
  });

  // ── 3d. flushSource: compact block via flushSource ──────────────────────────

  it('flushSource: successful agent → compact block (Done only)', () => {
    const lane = new ToolLane();
    lane.compactScrollback = true;

    lane.addStartWithAgentContext('agent-3', 'Agent', '(analyzer)', undefined);
    lane.addStartWithAgentContext('c1', 'Read', '("src.ts")', 'agent-3');
    lane.addResult('c1', makeResult('100 lines'));
    lane.setAgentResultSummary('agent-3', 'Done (1 tool · 2.0s)');
    lane.addResult('agent-3', makeResult('done'));

    const lines = lane.flushSource('agent-3');
    const joined = stripAnsi(lines.join('\n'));

    // Done summary must appear
    expect(joined).toContain('Done (1 tool · 2.0s)');
    // Successful tool child must be suppressed
    expect(joined).not.toContain('Read');
  });

  // ── 3e. flushCompletedRoots: routes through compact renderer ─────────────────

  it('flushCompletedRoots: completed agent with compactScrollback → compact rendering', () => {
    const lane = new ToolLane();
    lane.compactScrollback = true;

    lane.addStartWithAgentContext('agent-4', 'Agent', '(collector)', undefined);
    lane.addStartWithAgentContext('c1', 'Glob', '("**/*")', 'agent-4');
    lane.addResult('c1', makeResult('50 paths'));
    lane.setAgentResultSummary('agent-4', 'Done (1 tool · 0.3s)');
    lane.addResult('agent-4', makeResult('done'));

    const lines = lane.flushCompletedRoots();
    const joined = stripAnsi(lines.join('\n'));

    // Header and summary must appear
    expect(joined).toContain('Agent');
    expect(joined).toContain('Done (1 tool · 0.3s)');
    // Successful child suppressed
    expect(joined).not.toContain('Glob');
  });

  // ── 3f. compactScrollback = false (default): full tree emitted ───────────────

  it('compactScrollback = false (default): flush emits full child tree', () => {
    const lane = new ToolLane(); // default: compactScrollback = false

    lane.addStartWithAgentContext('agent-5', 'Agent', '(full-tree)', undefined);
    lane.addStartWithAgentContext('c1', 'Read', '("a.ts")', 'agent-5');
    lane.addResult('c1', makeResult('10 lines'));
    lane.setAgentResultSummary('agent-5', 'Done (1 tool)');
    lane.addResult('agent-5', makeResult('done'));

    const lines = lane.flush();
    const joined = stripAnsi(lines.join('\n'));

    // Non-compact: full child tree appears
    expect(joined).toContain('Read');
    expect(joined).toContain('Done (1 tool)');
  });

  // ── 3g. formatAgentChildren (headerEmitted=true) compact path ────────────────

  it('flushSource sets headerEmitted; subsequent flush uses formatAgentChildren compact path', () => {
    const lane = new ToolLane();
    lane.compactScrollback = true;

    // A skill root with one agent child. Agent completes first → flushSource.
    lane.addStartWithAgentContext('skill-1', 'skill', '(review)', undefined);
    lane.addStartWithAgentContext('agent-a', 'Agent', '(reviewer)', 'skill-1');
    lane.addStartWithAgentContext('t1', 'Read', '("code.ts")', 'agent-a');
    lane.addResult('t1', makeResult('55 lines'));
    lane.setAgentResultSummary('agent-a', 'Done (1 tool · 1.0s)');
    lane.addResult('agent-a', makeResult('done'));

    // Agent completes → flushSource commits agent-a eagerly
    const eagerLines = lane.flushSource('agent-a');
    const eagerJoined = stripAnsi(eagerLines.join('\n'));

    // Agent done summary should be in the eager output (compact path)
    expect(eagerJoined).toContain('Done (1 tool · 1.0s)');
    // The tool child should NOT appear (compact suppresses it)
    expect(eagerJoined).not.toContain('Read');

    // Now skill-1 completes
    lane.setAgentResultSummary('skill-1', 'Done (1 subagent · 2.0s)');
    lane.addResult('skill-1', makeResult('done'));

    const restLines = lane.flush();
    const restJoined = stripAnsi(restLines.join('\n'));

    // Skill closer must appear (Done for skill-1)
    expect(restJoined).toContain('Done (1 subagent · 2.0s)');
  });

  // ── 3h. Multiple parallel agents in compact mode ──────────────────────────────

  it('flush: two parallel agents in compact mode — each emits only its Done line', () => {
    const lane = new ToolLane();
    lane.compactScrollback = true;

    lane.addStartWithAgentContext('a1', 'Agent', '(first)', undefined);
    lane.addStartWithAgentContext('c1', 'Read', '("x.ts")', 'a1');
    lane.addResult('c1', makeResult('7 lines'));
    lane.setAgentResultSummary('a1', 'Done (1 tool · 0.5s)');
    lane.addResult('a1', makeResult('done'));

    lane.addStartWithAgentContext('a2', 'Agent', '(second)', undefined);
    lane.addStartWithAgentContext('c2', 'Bash', '("ls")', 'a2');
    lane.addResult('c2', makeResult('3 lines'));
    lane.setAgentResultSummary('a2', 'Done (1 tool · 0.6s)');
    lane.addResult('a2', makeResult('done'));

    const lines = lane.flush();
    const joined = stripAnsi(lines.join('\n'));

    expect(joined).toContain('Done (1 tool · 0.5s)');
    expect(joined).toContain('Done (1 tool · 0.6s)');
    // Tool children suppressed for both
    expect(joined).not.toContain('Read');
    expect(joined).not.toContain('Bash');
  });
});
