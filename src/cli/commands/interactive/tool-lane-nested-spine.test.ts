/**
 * Regression: a NON-LAST ancestor whose LAST child has its own children must
 * keep its spine column continuous through that child's subtree.
 *
 * Topology (the screenshot shape — a non-last subagent running a nested
 * subagent that itself has tool children):
 *
 *   ◉ skill
 *   │ ├─ Agent(A)         ← A is NOT the skill's last child (Z follows)
 *   │ │ ╰─ Agent(B)       ← B is A's only/last child
 *   │ │ │ ╰─ Read         ← B's child: A's column (col 3) MUST stay │ here
 *   │ ╰─ Agent(Z)
 *
 * Pre-fix bug: the recursion threaded the CHILD's `isLast` into the ancestor
 * vector, so an intermediate ancestor's column was derived from its child's
 * last-ness (via the active-spine offset) instead of its own. When the
 * intermediate node (A) was non-last but its rendered child (B) was last,
 * A's column closed one row too early — severing A's vertical between B's
 * header and B's children, so A visually detached from its sibling Z.
 */
import { describe, it, expect } from 'vitest';
import { ToolLane } from './tool-lane.js';
import { stripAnsi } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import { colorizeIndent, buildIndent, UNICODE_GLYPHS } from './tool-lane-render.js';
import { palette } from '../../palette.js';
import type { ChalkInstance } from 'chalk';

function makeResult(content: string, isError = false, extra?: Partial<ToolResultChunk>): ToolResultChunk {
  return { type: 'tool_result', toolUseId: 'unused', content, isError, ...extra };
}

/** Column (0-based) of the first tree connector (├ or ╰) on a row, or -1. */
function connectorCol(row: string): number {
  const mid = row.indexOf('├');
  const last = row.indexOf('╰');
  if (mid === -1) return last;
  if (last === -1) return mid;
  return Math.min(mid, last);
}

describe('nested-spine continuity (non-last ancestor, last child has children)', () => {
  function buildLane(): ToolLane {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('root', 'skill', '(root)', undefined);
    lane.addStartWithAgentContext('A', 'Agent', '(A)', 'root'); // NOT last (Z follows)
    lane.addStartWithAgentContext('B', 'Agent', '(B)', 'A'); // A's only/last child
    lane.addStartWithAgentContext('leaf', 'Read', '("x.ts")', 'B');
    lane.addResult('leaf', makeResult('1 line'));
    lane.addStartWithAgentContext('Z', 'Agent', '(Z)', 'root'); // skill's last child
    return lane;
  }

  it('overlay: A keeps its spine column open through B and B-descendant rows', () => {
    const lane = buildLane();
    const rows = stripAnsi(lane.getOverlay()).split('\n');

    const aRow = rows.find((l) => l.includes('Agent(A)'))!;
    const bRow = rows.find((l) => l.includes('Agent(B)'))!;
    const leafRow = rows.find((l) => l.includes('Read'))!;
    expect(aRow, `dump:\n${rows.join('\n')}`).toBeDefined();

    // A's own connector column — A's vertical lives here in its descendants.
    const aCol = connectorCol(aRow);
    expect(aCol).toBeGreaterThanOrEqual(0);

    // A's vertical must be a continuous '│' on BOTH B's row and B's child row.
    expect(bRow[aCol], `A vertical missing on B row\n${rows.join('\n')}`).toBe('│');
    expect(leafRow[aCol], `A vertical SEVERED on B-descendant row\n${rows.join('\n')}`).toBe('│');
  });

  it('overlay: no severed-spine gap — col stays │ from A down to Z', () => {
    const lane = buildLane();
    const rows = stripAnsi(lane.getOverlay()).split('\n');
    const aRow = rows.find((l) => l.includes('Agent(A)'))!;
    const aCol = connectorCol(aRow);

    // Every row strictly between A's header and Z's header must carry A's
    // vertical at aCol (│), then Z closes it with a connector.
    const aIdx = rows.indexOf(aRow);
    const zRow = rows.find((l) => l.includes('Agent(Z)'))!;
    const zIdx = rows.indexOf(zRow);
    for (let i = aIdx + 1; i < zIdx; i++) {
      expect(rows[i]![aCol], `row ${i} broke A's spine: ${JSON.stringify(rows[i])}`).toBe('│');
    }
    // Z is A's sibling under the same parent — it closes the column.
    expect(connectorCol(zRow)).toBe(aCol);
  });

  it('flush (scrollback): A keeps its spine open through B-descendant rows', () => {
    // Settle the whole tree and flush it to scrollback via dispose-time flush().
    const lane = buildLane();
    lane.setAgentResultSummary('B', 'Done');
    lane.addResult('B', makeResult('done'));
    lane.setAgentResultSummary('A', 'Done');
    lane.addResult('A', makeResult('done'));
    lane.setAgentResultSummary('Z', 'Done');
    lane.addResult('Z', makeResult('done'));
    lane.setAgentResultSummary('root', 'Done');
    lane.addResult('root', makeResult('done'));

    const rows = lane.flush().flatMap((s) => s.split('\n')).map(stripAnsi).filter((l) => l.length > 0);
    const aRow = rows.find((l) => l.includes('Agent(A)'))!;
    const leafRow = rows.find((l) => l.includes('Read'))!;
    expect(aRow, `dump:\n${rows.join('\n')}`).toBeDefined();
    expect(leafRow, `dump:\n${rows.join('\n')}`).toBeDefined();
    const aCol = connectorCol(aRow);
    expect(leafRow[aCol], `A vertical SEVERED in scrollback\n${rows.join('\n')}`).toBe('│');
  });
});

describe('multi-line outcome spine continuity (hiddenLineCount + tailPreview)', () => {
  /**
   * Regression: formatOutcome returns a multi-line string when
   * hiddenLineCount and/or tailPreview are set. The continuation lines
   * (e.g. "151 earlier lines hidden", tail preview lines) carried a
   * hardcoded 4-space indent that lacked tree-spine glyphs, severing
   * the spine in nested views.
   */

  function buildMultiLineTree(): ToolLane {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('root', 'skill', '(root)', undefined);
    lane.addStartWithAgentContext('A', 'Agent', '(A)', 'root');
    // A second sibling of A under root, so root's spine stays open
    lane.addStartWithAgentContext('A2', 'Agent', '(A2)', 'root');
    // bash with multi-line output (hiddenLineCount + tailPreview)
    lane.addStartWithAgentContext('bash1', 'bash', 'cmd1', 'A');
    lane.addResult('bash1', makeResult('', false, {
      lineCount: 160,
      hiddenLineCount: 151,
      tailPreview: ['line 152', 'line 153'],
    }));
    // A second sibling under A to keep A's spine open through bash1's continuation
    lane.addStartWithAgentContext('bash2', 'bash', 'cmd2', 'A');
    return lane;
  }

  it('overlay: continuation lines of multi-line outcome carry spine glyphs', () => {
    const lane = buildMultiLineTree();
    const rawOverlay = lane.getOverlay();
    const rows = stripAnsi(rawOverlay).split('\n');

    // Find the "earlier lines hidden" row
    const hiddenRow = rows.find((l) => l.includes('earlier lines hidden'));
    expect(hiddenRow, `no hidden-lines row found\n${rows.join('\n')}`).toBeDefined();

    // The root skill anchors at col 0 with ◉. A is NOT last (A2 follows),
    // so root's spine (col 0) must be '│'. A's spine (col 3) must also be '│'
    // since bash1 is not last (bash2 follows). (Spine is 3 cells wide, so A's
    // column lives at col 3, not col 2.)
    expect(hiddenRow![0], `root spine severed on hidden-lines row\n${rows.join('\n')}`).toBe('│');
    expect(hiddenRow![3], `A spine severed on hidden-lines row\n${rows.join('\n')}`).toBe('│');

    // Tail preview lines must also carry spine glyphs
    const tailRow = rows.find((l) => l.includes('line 152'));
    expect(tailRow, `no tail-preview row found\n${rows.join('\n')}`).toBeDefined();
    expect(tailRow![0], `root spine severed on tail-preview row\n${rows.join('\n')}`).toBe('│');
    expect(tailRow![3], `A spine severed on tail-preview row\n${rows.join('\n')}`).toBe('│');
  });

  it('flush: continuation lines carry spine glyphs in scrollback', () => {
    const lane = buildMultiLineTree();
    // Settle everything
    lane.addResult('bash2', makeResult('ok'));
    lane.setAgentResultSummary('A', 'Done');
    lane.addResult('A', makeResult('done'));
    lane.setAgentResultSummary('A2', 'Done');
    lane.addResult('A2', makeResult('done'));
    lane.setAgentResultSummary('root', 'Done');
    lane.addResult('root', makeResult('done'));

    const rows = lane.flush().flatMap((s) => s.split('\n')).map(stripAnsi).filter((l) => l.length > 0);

    const hiddenRow = rows.find((l) => l.includes('earlier lines hidden'));
    expect(hiddenRow, `no hidden-lines row in scrollback\n${rows.join('\n')}`).toBeDefined();
    expect(hiddenRow![0], `root spine severed in scrollback hidden-lines row\n${rows.join('\n')}`).toBe('│');

    const tailRow = rows.find((l) => l.includes('line 152'));
    expect(tailRow, `no tail-preview row in scrollback\n${rows.join('\n')}`).toBeDefined();
    expect(tailRow![0], `root spine severed in scrollback tail-preview row\n${rows.join('\n')}`).toBe('│');
  });
});

// ---------------------------------------------------------------------------
// D: no stacked spine-only separator rows between consecutive nested commits
// ---------------------------------------------------------------------------

describe('flushSource — no consecutive separator-only rows for nested agents (defect D)', () => {
  /**
   * Defect D: flushSource appends scrollbackSeparator(depth) after every
   * per-agent commit. At depth > 0 that is a dim spine string (│  per
   * ancestor). When several nested agents complete without an agentResultSummary
   * their flushSource returns ONLY the separator (no block), so N consecutive
   * such commits produce N consecutive spine-only rows in the scrollback.
   *
   * Trigger conditions:
   *  - Leaf agents have no agentResultSummary set (blockLines=[])
   *  - Their parent agents have headerEmitted=true and no remaining children
   *    → flushSource(parent) returns just [separator]
   *  - Multiple such parents complete in sequence → stacking
   *
   * Contract after fix: no two consecutive elements in the combined output of
   * multiple flushSource calls may both be separator-only rows (every non-empty
   * char is │ or space, after ANSI-strip).
   *
   * Topology used (3-level, 3 mid-agents each with a leaf flushed first):
   *   ◉ skill (live)
   *   │ ├─ Agent(orch)
   *   │ │  ├─ Agent(mid1) → [Agent(mid1_leaf)]   ← leaf flushed first
   *   │ │  ├─ Agent(mid2) → [Agent(mid2_leaf)]   ← leaf flushed first
   *   │ │  ╰─ Agent(mid3) → [Agent(mid3_leaf)]   ← leaf flushed first
   *   then mid1/mid2/mid3 flushed → each returns only ["│  │"] → stacking
   */
  function isSpineOnlyRow(line: string): boolean {
    const plain = stripAnsi(line).trimEnd();
    // A separator-only row consists solely of │ and spaces (no other chars).
    return plain.length > 0 && /^[│ ]+$/.test(plain);
  }

  it('nested agents with no summary flushed after children produce no back-to-back spine-only rows', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(root)', undefined);
    lane.addStartWithAgentContext('orch', 'Agent', '(orch)', 'skill-1');

    for (const mid of ['mid1', 'mid2', 'mid3']) {
      lane.addStartWithAgentContext(mid, 'Agent', `(${mid})`, 'orch');
      const leaf = `${mid}_leaf`;
      lane.addStartWithAgentContext(leaf, 'Agent', `(${leaf})`, mid);
      lane.addResult(leaf, makeResult('done'));
      // No setAgentResultSummary — this is the trigger condition
      lane.addResult(mid, makeResult('done'));
      // No setAgentResultSummary for mid either
    }

    // Flush leaves first (triggers headerEmitted=true on ancestors)
    // then flush parents — each parent returns only [separator]
    const order = ['mid1_leaf', 'mid2_leaf', 'mid3_leaf', 'mid1', 'mid2', 'mid3'];
    const combined: string[] = [];
    for (const id of order) {
      combined.push(...lane.flushSource(id));
    }

    // Check no two consecutive elements are both spine-only rows.
    for (let i = 0; i < combined.length - 1; i++) {
      const curr = combined[i]!;
      const next = combined[i + 1]!;
      if (isSpineOnlyRow(curr) && isSpineOnlyRow(next)) {
        throw new Error(
          `Consecutive spine-only rows at indices ${i} and ${i + 1}:\n` +
          `  [${i}] ${JSON.stringify(curr)}\n` +
          `  [${i + 1}] ${JSON.stringify(next)}\n` +
          `Full output:\n${combined.map((l, idx) => `  [${idx}] ${JSON.stringify(l)}`).join('\n')}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Depth-graded spine dimming — spineChalk() / colorizeIndent() coverage
// ---------------------------------------------------------------------------

/**
 * A stand-in ChalkInstance that renders `<tag>:<text>` uncolored. Used to
 * distinguish which palette.spineToneN was selected without depending on the
 * actual hex values (which vary per theme and can coincide at low ANSI depth).
 */
function sentinelTone(tag: string): ChalkInstance {
  return ((...text: unknown[]) => `${tag}:${text.join(' ')}`) as ChalkInstance;
}

describe('spineChalk / colorizeIndent — depth-graded spine dimming', () => {
  it('slot 0 uses spineTone0, slot 1 uses spineTone1, slot 2+ uses spineTone2 (startDepth=0)', () => {
    const g = UNICODE_GLYPHS;
    const savedT0 = palette.spineTone0;
    const savedT1 = palette.spineTone1;
    const savedT2 = palette.spineTone2;
    try {
      palette.spineTone0 = sentinelTone('T0');
      palette.spineTone1 = sentinelTone('T1');
      palette.spineTone2 = sentinelTone('T2');

      // Three-level indent: [false, false, true] → ancestor0(open), ancestor1(open), parent(open)
      // buildIndent appends one g.spine per slot: 3 spine glyphs = 3 slots
      const plain = buildIndent([false, false], g); // ancestorIsLast=[false,false] → 3 spine slots
      const colored = colorizeIndent(plain, g, 0);

      // slot 0 → T0, slot 1 → T1, slot 2 → T2
      expect(colored).toContain('T0:│  ');
      expect(colored).toContain('T1:│  ');
      expect(colored).toContain('T2:│  ');
    } finally {
      palette.spineTone0 = savedT0;
      palette.spineTone1 = savedT1;
      palette.spineTone2 = savedT2;
    }
  });

  it('startDepth shifts the tone assignment — depth-1 caller starts at T1', () => {
    const g = UNICODE_GLYPHS;
    const savedT0 = palette.spineTone0;
    const savedT1 = palette.spineTone1;
    const savedT2 = palette.spineTone2;
    try {
      palette.spineTone0 = sentinelTone('T0');
      palette.spineTone1 = sentinelTone('T1');
      palette.spineTone2 = sentinelTone('T2');

      // Single-slot indent (one g.spine). With startDepth=1, slot 0 maps to toneIdx=min(1+0,2)=1.
      const plain = g.spine; // one spine slot
      const colored = colorizeIndent(plain, g, 1);
      expect(colored).toContain('T1:');
      expect(colored).not.toContain('T0:');
    } finally {
      palette.spineTone0 = savedT0;
      palette.spineTone1 = savedT1;
      palette.spineTone2 = savedT2;
    }
  });

  it('toneIdx is floored at 2 — depth ≥2 ancestors all use spineTone2', () => {
    const g = UNICODE_GLYPHS;
    const savedT2 = palette.spineTone2;
    try {
      palette.spineTone2 = sentinelTone('T2');

      // startDepth=2, single slot → toneIdx = min(2+0, 2) = 2.
      const plain = g.spine;
      const colored = colorizeIndent(plain, g, 2);
      expect(colored).toContain('T2:');

      // startDepth=5 (beyond the floor) → toneIdx still floored at 2.
      const colored5 = colorizeIndent(plain, g, 5);
      expect(colored5).toContain('T2:');
    } finally {
      palette.spineTone2 = savedT2;
    }
  });

  it('closed spine slots (spineClosed / spaces) pass through un-toned', () => {
    const g = UNICODE_GLYPHS;
    const savedT0 = palette.spineTone0;
    const savedT1 = palette.spineTone1;
    try {
      palette.spineTone0 = sentinelTone('T0');
      palette.spineTone1 = sentinelTone('T1');

      // ancestorIsLast=[true] → first slot is spineClosed (spaces, slot 0),
      // second slot is the live parent spine (slot 1 → toneIdx=min(0+1,2)=1 → T1).
      const plain = buildIndent([true], g); // g.spineClosed + g.spine
      const colored = colorizeIndent(plain, g, 0);

      // The closed slot (spaces) must pass through raw (no tone wrapper).
      expect(colored).toContain(g.spineClosed);
      // The live spine slot (slot 1 at startDepth=0) is T1, not T0.
      expect(colored).toContain('T1:│  ');
      // And critically: T0 is NOT applied (the closed slot didn't accidentally get it).
      expect(colored).not.toContain('T0:');
    } finally {
      palette.spineTone0 = savedT0;
      palette.spineTone1 = savedT1;
    }
  });

  it('reads palette.spineToneN at call time (no theme-swap freeze)', () => {
    const g = UNICODE_GLYPHS;
    const savedT0 = palette.spineTone0;
    try {
      palette.spineTone0 = sentinelTone('BEFORE');
      const before = colorizeIndent(g.spine, g, 0);
      expect(before).toContain('BEFORE:');

      // Swap to a new sentinel — the next call must use the NEW value.
      palette.spineTone0 = sentinelTone('AFTER');
      const after = colorizeIndent(g.spine, g, 0);
      expect(after).toContain('AFTER:');
      expect(after).not.toContain('BEFORE:');
    } finally {
      palette.spineTone0 = savedT0;
    }
  });
});

// ---------------------------------------------------------------------------
// #4329 — orphan roots when parent commits over running children
// ---------------------------------------------------------------------------

/**
 * Acceptance test for #4329.
 *
 * Topology: root → child → grandchild, grandchild finishes last.
 *
 *   ◉ Agent(root)        ← root finishes first, flushSource absorbs root+child
 *   │ ╰─ Agent(child)    ← child is still running when root flushes
 *   │    ╰─ Read         ← grandchild tool, calls after root absorbed child
 *
 * Without the fix: after flushSource('rootId') deletes 'childId' from the
 * lane, the grandchild's next tool call via addStartWithAgentContext(...,
 * 'childId') re-inserts an entry with a dangling agentContext. That entry
 * then surfaces as an orphan root in committed scrollback.
 *
 * With the fix (Direction 2 — track absorbed ids): flushSource records
 * 'childId' in absorbedIds; addStartWithAgentContext silently drops any
 * call whose agentContext is absorbed.
 */
describe('#4329 — no orphan roots when parent flushSource absorbs a still-running child', () => {
  it('addStartWithAgentContext drops entries whose agentContext was absorbed', () => {
    const lane = new ToolLane();

    // Build root → child → grandchild topology
    lane.addStartWithAgentContext('rootId',  'Agent', '(root)',  undefined);
    lane.addStartWithAgentContext('childId', 'Agent', '(child)', 'rootId');
    lane.addStartWithAgentContext('gcTool1', 'Read',  '"a.ts"',  'childId');
    lane.addResult('gcTool1', makeResult('line 1'));

    // Root completes and is flushed — this deletes rootId AND childId from
    // the lane (BFS collects all descendants). childId is now absorbed.
    lane.setAgentResultSummary('root', 'Done');
    lane.addResult('rootId', makeResult('root done'));
    lane.flushSource('rootId');

    // Verify child was absorbed
    expect(lane.isAbsorbed('childId'), 'childId must be absorbed after flushSource(rootId)').toBe(true);

    // The lane should be empty (root + child + gcTool1 all removed)
    expect(lane.hasPending(), 'lane must be empty after flushSource of root').toBe(false);

    // Grandchild keeps running and emits another tool call with parentId=childId.
    // Pre-fix: this would re-insert an entry with agentContext='childId' (dangling).
    // Post-fix: the call is silently dropped.
    lane.addStartWithAgentContext('gcTool2', 'Bash', '"ls"', 'childId');

    // The lane must still be empty — no orphan entry was created.
    expect(lane.hasPending(), 'lane must remain empty — no orphan entry for absorbed parent').toBe(false);
  });

  it('flush() at turn end leaves no entries referencing a deleted agentContext', () => {
    const lane = new ToolLane();

    lane.addStartWithAgentContext('rootId',  'Agent', '(root)',  undefined);
    lane.addStartWithAgentContext('childId', 'Agent', '(child)', 'rootId');
    lane.addStartWithAgentContext('gcTool1', 'Read',  '"a.ts"',  'childId');
    lane.addResult('gcTool1', makeResult('line 1'));

    // Root flushes first (child still running)
    lane.setAgentResultSummary('rootId', 'Done');
    lane.addResult('rootId', makeResult('root done'));
    const scrollback = lane.flushSource('rootId');

    // Scrollback from flushSource must contain the root block
    expect(scrollback.join('\n')).toContain('root');

    // Grandchild emits more tool events — must be silently dropped
    lane.addStartWithAgentContext('gcTool2', 'Bash', '"ls"',     'childId');
    lane.addStartWithAgentContext('gcTool3', 'Write', '"b.ts"',  'childId');

    // Dispose-time flush must produce nothing (lane was already empty)
    const disposeLines = lane.flush().filter((l) => l.trim().length > 0);
    expect(
      disposeLines,
      `No orphan blocks expected at turn end; got: ${JSON.stringify(disposeLines)}`,
    ).toHaveLength(0);
  });

  it('absorbed set clears on flush() so the next turn starts fresh', () => {
    const lane = new ToolLane();

    lane.addStartWithAgentContext('rootId', 'Agent', '(root)', undefined);
    lane.addStartWithAgentContext('childId', 'Agent', '(child)', 'rootId');
    lane.addResult('rootId', makeResult('done'));
    lane.flushSource('rootId');
    expect(lane.isAbsorbed('childId')).toBe(true);

    // Full flush (turn end) clears the absorbed set
    lane.flush();
    expect(lane.isAbsorbed('childId'), 'absorbedIds must be cleared after flush()').toBe(false);

    // A new turn can use the same synthetic ids without being silently dropped
    lane.addStartWithAgentContext('childId', 'Agent', '(child-turn2)', undefined);
    expect(lane.hasPending(), 'new-turn entry must be accepted after absorbedIds cleared').toBe(true);
  });

  it('non-absorbed agentContext entries are still accepted normally', () => {
    const lane = new ToolLane();

    // Two parallel roots — flushing one must not block the other
    lane.addStartWithAgentContext('rootA', 'Agent', '(A)', undefined);
    lane.addStartWithAgentContext('rootB', 'Agent', '(B)', undefined);
    lane.addStartWithAgentContext('childA', 'Read', '"a.ts"', 'rootA');
    lane.addResult('rootA', makeResult('done'));
    lane.flushSource('rootA');

    // rootB and its children should still be insertable
    lane.addStartWithAgentContext('childB', 'Read', '"b.ts"', 'rootB');
    expect(lane.hasPending(), 'rootB children must still be accepted').toBe(true);
    expect(lane.isAbsorbed('rootB'), 'rootB must NOT be absorbed').toBe(false);
  });
});
