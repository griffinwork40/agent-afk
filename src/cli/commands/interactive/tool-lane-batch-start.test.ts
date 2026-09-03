/**
 * Tests for ToolLane live parallel-batch indicator (Phase 2, issue #516).
 *
 * `notifyBatchStart` — registers a pending concurrent batch so the overlay
 * renders `[×N]` next to each in-flight member row.
 *
 * Constraints:
 *  - Append-only scrollback: committed rows can't be re-laid-out.
 *  - Badge must disappear as soon as all member results arrive.
 *  - Phase 1 completed-row badges (∥i/N) continue to work alongside.
 */

import { describe, it, expect } from 'vitest';
import { ToolLane } from './tool-lane.js';
import { stripAnsi } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';

function makeResult(content: string, isError = false): ToolResultChunk {
  return { type: 'tool_result', toolUseId: 'unused', content, isError };
}

/** Grab a snapshot of all overlay lines (ANSI-stripped). */
function overlayLines(lane: ToolLane): string[] {
  return stripAnsi(lane.getOverlay()).split('\n').filter(Boolean);
}

/** Returns true if any overlay line mentions `[×N]`. */
function hasBadge(lines: string[], width: number): boolean {
  return lines.some((l) => l.includes(`[×${width}]`));
}

describe('ToolLane — notifyBatchStart live batch badge', () => {
  it('shows [×2] on in-flight rows after notifyBatchStart(2)', () => {
    const lane = new ToolLane();
    lane.addStart('id-read', 'read_file', '("x.ts")');
    lane.addStart('id-glob', 'glob', '("**/*.ts")');
    lane.notifyBatchStart(2, ['id-read', 'id-glob']);

    const lines = overlayLines(lane);
    expect(hasBadge(lines, 2)).toBe(true);
  });

  it('shows the badge on both member rows, not on non-members', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.addStart('id-b', 'glob', '("*.ts")');
    lane.addStart('id-c', 'grep', '(pattern)');
    // Only a and b are in the batch; c is sequential
    lane.notifyBatchStart(2, ['id-a', 'id-b']);

    const lines = overlayLines(lane);
    // The badge appears (at least once) for a and b
    const memberLines = lines.filter((l) => l.includes('[×2]'));
    expect(memberLines.length).toBeGreaterThanOrEqual(1);

    // c's line must NOT have the badge — check the grep line specifically.
    // It shows "grep" in the prefix; find that line.
    const grepLines = lines.filter((l) => l.includes('grep'));
    for (const gl of grepLines) {
      expect(gl).not.toContain('[×2]');
    }
  });

  it('clears the badge once all batch members receive results', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.addStart('id-b', 'glob', '("*.ts")');
    lane.notifyBatchStart(2, ['id-a', 'id-b']);

    // Both still in-flight → badge present
    expect(hasBadge(overlayLines(lane), 2)).toBe(true);

    // First result arrives — batch still in-flight
    lane.addResult('id-a', makeResult('content-a'));
    // Badge must still be visible (one member still running)
    // (id-b is still in-flight so the badge persists on its row)
    const afterFirst = overlayLines(lane);
    const bStillRunning = afterFirst.some((l) => l.includes('glob') && l.includes('[×2]'));
    expect(bStillRunning).toBe(true);

    // Second result arrives — batch fully done
    lane.addResult('id-b', makeResult('content-b'));
    // Badge should be gone from all rows
    expect(hasBadge(overlayLines(lane), 2)).toBe(false);
  });

  it('replaces a prior batch badge when a new wave starts (multi-wave turn)', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.addStart('id-b', 'glob', '("*.ts")');
    lane.notifyBatchStart(2, ['id-a', 'id-b']);
    lane.addResult('id-a', makeResult('a'));
    lane.addResult('id-b', makeResult('b'));

    // Second wave starts
    lane.addStart('id-c', 'grep', '(pattern)');
    lane.addStart('id-d', 'list_directory', '("src/")');
    lane.notifyBatchStart(2, ['id-c', 'id-d']);

    const lines = overlayLines(lane);
    // The second wave badge appears for the still-in-flight members
    expect(hasBadge(lines, 2)).toBe(true);
  });

  it('renders no badge when no batch is active (normal sequential turn)', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'bash', '("ls")');

    const lines = overlayLines(lane);
    expect(lines.some((l) => l.includes('[×'))).toBe(false);
  });

  it('clears badge state immediately when all results arrive on the same tick', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.addStart('id-b', 'read_file', '("b.ts")');
    lane.notifyBatchStart(2, ['id-a', 'id-b']);

    // Both results arrive synchronously
    lane.addResult('id-a', makeResult('content-a'));
    lane.addResult('id-b', makeResult('content-b'));

    // Both entries have results → badge cleared
    expect(hasBadge(overlayLines(lane), 2)).toBe(false);
  });
});
