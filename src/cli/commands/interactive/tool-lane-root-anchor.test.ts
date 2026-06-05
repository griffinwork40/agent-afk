/**
 * Regression: flat-leaf ROOT tools (main-session calls, agentContext=undefined)
 * dispatched alongside a NESTING root (skill / Agent / compose) must anchor
 * their own col-0 ◉ turn-root marker in the LIVE OVERLAY.
 *
 * The reported bug (screenshot shape): a subagent block renders with a `│`
 * spine at col 0 and connectors at col 2; three main-session `read_file` calls
 * dispatched afterward rendered at a bare 2-space lead, placing their `●` glyph
 * at col 2 — directly under the subagent's connector column with NOTHING in
 * col 0. The eye read them as severed / orphaned nodes that "fell out" of the
 * subagent tree.
 *
 * Fix: when the overlay mixes a NESTING root with flat-leaf roots, the flat
 * roots anchor col-0 with ◉ (the same marker the dispatch head uses). The
 * `│ → ◉` transition at col 0 is an honest "spine ended, new root begins"
 * signal. A pure flat-leaf turn keeps the clean 2-space lead — no spine to
 * collide with, so the marker would be gratuitous.
 */
import { describe, it, expect } from 'vitest';
import { ToolLane } from './tool-lane.js';
import { stripAnsi } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';

function makeResult(content: string, isError = false): ToolResultChunk {
  return { type: 'tool_result', toolUseId: 'unused', content, isError };
}

describe('flat-leaf root anchoring (turn-root ◉ when mixed with a NESTING root)', () => {
  it('overlay: flat read_file roots anchor col-0 ◉ when a subagent block is present', () => {
    const lane = new ToolLane();
    // NESTING root (skill) with a completed child → renders a spine in the overlay.
    lane.addStartWithAgentContext('skill', 'skill', '(hero-migration)', undefined);
    lane.addStartWithAgentContext('mem', 'memory_search', '("landing page")', 'skill');
    lane.addResult('mem', makeResult('1 result'));
    // Main-session flat-leaf roots dispatched AFTER the subagent block.
    lane.addStartWithAgentContext('r1', 'read_file', '("Terminal.tsx")', undefined);
    lane.addStartWithAgentContext('r2', 'read_file', '("Hero.tsx")', undefined);

    const rows = stripAnsi(lane.getOverlay()).split('\n');
    const readRows = rows.filter((l) => l.includes('read_file'));
    expect(readRows.length, `dump:\n${rows.join('\n')}`).toBe(2);
    for (const row of readRows) {
      // Anchored: row begins with the turn-root marker at col 0, NOT a blank lead.
      expect(
        row.startsWith('◉ '),
        `read_file root not ◉-anchored:\n${JSON.stringify(row)}\nfull:\n${rows.join('\n')}`,
      ).toBe(true);
    }

    // Sanity: the subagent's child still carries the `│` spine at col 0, so the
    // `│ → ◉` transition the fix relies on is actually present.
    const memRow = rows.find((l) => l.includes('memory_search'))!;
    expect(memRow[0], `subagent child should carry a col-0 spine\n${rows.join('\n')}`).toBe('│');
  });

  it('overlay: a single flat read_file root anchors ◉ alongside an Agent dispatch', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('agent', 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('grep', 'grep', '("pattern")', 'agent');
    lane.addStartWithAgentContext('r1', 'read_file', '("Hero.tsx")', undefined);

    const rows = stripAnsi(lane.getOverlay()).split('\n');
    const readRow = rows.find((l) => l.includes('read_file'))!;
    expect(readRow, `dump:\n${rows.join('\n')}`).toBeDefined();
    expect(readRow.startsWith('◉ '), `read_file root not ◉-anchored:\n${JSON.stringify(readRow)}`).toBe(true);
  });

  it('overlay: flat read_file roots keep the clean 2-space lead when NO subagent present', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('r1', 'read_file', '("a.ts")', undefined);
    lane.addStartWithAgentContext('r2', 'read_file', '("b.ts")', undefined);
    lane.addResult('r1', makeResult('10 lines'));

    const rows = stripAnsi(lane.getOverlay()).split('\n');
    const readRows = rows.filter((l) => l.includes('read_file'));
    expect(readRows.length, `dump:\n${rows.join('\n')}`).toBe(2);
    for (const row of readRows) {
      expect(
        row.startsWith('◉ '),
        `clean flat-only turn should NOT anchor ◉:\n${JSON.stringify(row)}`,
      ).toBe(false);
      expect(
        row.startsWith('  '),
        `clean flat root should keep the 2-space lead:\n${JSON.stringify(row)}`,
      ).toBe(true);
    }
  });
});
