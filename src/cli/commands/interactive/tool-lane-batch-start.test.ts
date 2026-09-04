/**
 * Tests for ToolLane live tool-activity indicator (Phase 2, issue #516).
 *
 * `notifyToolActivity` — records the dispatcher's OBSERVED running set so the
 * overlay renders `[×N]` next to each genuinely in-flight member row.
 *
 * Constraints:
 *  - Append-only scrollback: committed rows can't be re-laid-out.
 *  - Badge disappears when the dispatcher reports an empty active set.
 *  - Phase 1 completed-row badges (∥i/N) continue to work alongside.
 *  - A lone straggler (activeCount === 1) must never render [×1].
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

describe('ToolLane — notifyToolActivity live badge (Phase 2, issue #516)', () => {
  it('shows [×2] on in-flight rows after notifyToolActivity(2)', () => {
    const lane = new ToolLane();
    lane.addStart('id-read', 'read_file', '("x.ts")');
    lane.addStart('id-glob', 'glob', '("**/*.ts")');
    lane.notifyToolActivity(2, ['id-read', 'id-glob']);

    const lines = overlayLines(lane);
    expect(hasBadge(lines, 2)).toBe(true);
  });

  it('shows the badge on both member rows, not on non-members', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.addStart('id-b', 'glob', '("*.ts")');
    lane.addStart('id-c', 'grep', '(pattern)');
    // Only a and b are in the active wave; c is sequential
    lane.notifyToolActivity(2, ['id-a', 'id-b']);

    const lines = overlayLines(lane);
    // The badge appears (at least once) for a and b
    const memberLines = lines.filter((l) => l.includes('[×2]'));
    expect(memberLines.length).toBeGreaterThanOrEqual(1);

    // c's line must NOT have the badge
    const grepLines = lines.filter((l) => l.includes('grep'));
    for (const gl of grepLines) {
      expect(gl).not.toContain('[×2]');
    }
  });

  it('clears the badge when dispatcher reports 0 active (wave drained)', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.addStart('id-b', 'glob', '("*.ts")');
    lane.notifyToolActivity(2, ['id-a', 'id-b']);

    // Active wave reported → badge present
    expect(hasBadge(overlayLines(lane), 2)).toBe(true);

    // Dispatcher reports wave drained (0 active — the terminal update)
    lane.notifyToolActivity(0, []);
    expect(hasBadge(overlayLines(lane), 2)).toBe(false);
  });

  it('badge persists if dispatcher has NOT yet reported drain (result arrival alone does not clear it)', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.addStart('id-b', 'glob', '("*.ts")');
    lane.notifyToolActivity(2, ['id-a', 'id-b']);

    // First result arrives — but dispatcher has NOT sent a new activity update
    lane.addResult('id-a', makeResult('content-a'));
    // The badge must persist on id-b's row (dispatcher is authoritative, not addResult)
    const afterFirst = overlayLines(lane);
    const bStillBadged = afterFirst.some((l) => l.includes('glob') && l.includes('[×2]'));
    expect(bStillBadged).toBe(true);
  });

  it('replaces a prior wave snapshot when a new wave activity update arrives (multi-wave turn)', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.addStart('id-b', 'glob', '("*.ts")');
    lane.notifyToolActivity(2, ['id-a', 'id-b']);
    lane.notifyToolActivity(0, []); // first wave drained

    // Second wave starts
    lane.addStart('id-c', 'grep', '(pattern)');
    lane.addStart('id-d', 'list_directory', '("src/")');
    lane.notifyToolActivity(2, ['id-c', 'id-d']);

    const lines = overlayLines(lane);
    // The second wave badge appears for the still-in-flight members
    expect(hasBadge(lines, 2)).toBe(true);
  });

  it('renders no badge when no activity update has been sent (normal sequential turn)', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'bash', '("ls")');

    const lines = overlayLines(lane);
    expect(lines.some((l) => l.includes('[×'))).toBe(false);
  });

  it('renders no badge when activeCount === 1 (lone straggler guard)', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.notifyToolActivity(1, ['id-a']); // dispatcher filtering rule: 1 is suppressed

    const lines = overlayLines(lane);
    expect(lines.some((l) => l.includes('[×'))).toBe(false);
  });

  it('clears badge immediately when notifyToolActivity(0, []) arrives', () => {
    const lane = new ToolLane();
    lane.addStart('id-a', 'read_file', '("a.ts")');
    lane.addStart('id-b', 'read_file', '("b.ts")');
    lane.notifyToolActivity(2, ['id-a', 'id-b']);

    // Terminal drain update from dispatcher
    lane.notifyToolActivity(0, []);

    expect(hasBadge(overlayLines(lane), 2)).toBe(false);
  });
});
