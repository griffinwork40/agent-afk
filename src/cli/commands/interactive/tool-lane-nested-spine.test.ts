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
