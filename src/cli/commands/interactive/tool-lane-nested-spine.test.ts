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
 *   │ │ │ ╰─ Read         ← B's child: A's column (col 2) MUST stay │ here
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

function makeResult(content: string, isError = false): ToolResultChunk {
  return { type: 'tool_result', toolUseId: 'unused', content, isError };
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
