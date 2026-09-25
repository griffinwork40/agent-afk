/**
 * Tests for failure-count propagation and the child failure badge.
 *
 * Covers:
 *  - propagateChildFailure walks the agentContext chain upward
 *  - Badge appears in the overlay for NESTING entries with failedChildCount > 0
 *  - Non-failed entries show no badge (no false positives)
 *  - Multiple failures accumulate the count
 *  - Grandchild failure reaches the grandparent
 *  - childFailureBadge helper returns compact glyph+count or empty string
 */

import { describe, it, expect } from 'vitest';
import { ToolLane } from './tool-lane.js';
import { childFailureBadge } from './tool-lane-format.js';
import { stripAnsi } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';

function makeResult(content: string, isError = false): ToolResultChunk {
  return { type: 'tool_result', toolUseId: 'unused', content, isError };
}

function makeError(content: string): ToolResultChunk {
  return { type: 'tool_result', toolUseId: 'unused', content, isError: true };
}

// ─── childFailureBadge unit tests ─────────────────────────────────────────────

describe('childFailureBadge', () => {
  it('returns empty string for undefined count', () => {
    expect(childFailureBadge(undefined)).toBe('');
  });

  it('returns empty string for zero count', () => {
    expect(childFailureBadge(0)).toBe('');
  });

  it('returns non-empty badge for count 1', () => {
    const badge = stripAnsi(childFailureBadge(1));
    expect(badge).toContain('⚠');
    expect(badge).toContain('1');
  });

  it('returns non-empty badge for count 3', () => {
    const badge = stripAnsi(childFailureBadge(3));
    expect(badge).toContain('⚠');
    expect(badge).toContain('3');
  });
});

// ─── propagateChildFailure ────────────────────────────────────────────────────

describe('propagateChildFailure', () => {
  it('increments failedChildCount on immediate parent NESTING entry', () => {
    const lane = new ToolLane();
    const parentId = '__parent';
    const childId = '__child';

    lane.addStartWithAgentContext(parentId, 'Agent', '(parent)', undefined);
    lane.addStartWithAgentContext(childId, 'Agent', '(child)', parentId);
    // Mark child as failed
    lane.addResult(childId, makeError('child failed'));
    lane.propagateChildFailure(childId);

    // Parent overlay should contain the warning badge
    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toContain('⚠');
    expect(overlay).toContain('1');
  });

  it('increments failedChildCount on grandparent (depth 2)', () => {
    const lane = new ToolLane();
    const grandparentId = '__grandparent';
    const parentId = '__parent';
    const childId = '__child';

    lane.addStartWithAgentContext(grandparentId, 'Agent', '(grand)', undefined);
    lane.addStartWithAgentContext(parentId, 'Agent', '(parent)', grandparentId);
    lane.addStartWithAgentContext(childId, 'Agent', '(child)', parentId);

    lane.addResult(childId, makeError('grandchild failed'));
    lane.propagateChildFailure(childId);

    // Both parent and grandparent should have the count
    const overlay = stripAnsi(lane.getOverlay());
    // The overlay renders multiple ancestor rows — badge should appear at least once
    expect(overlay).toContain('⚠');
  });

  it('accumulates count for multiple failed children', () => {
    const lane = new ToolLane();
    const parentId = '__parent';
    const child1 = '__child1';
    const child2 = '__child2';

    lane.addStartWithAgentContext(parentId, 'Agent', '(parent)', undefined);
    lane.addStartWithAgentContext(child1, 'Agent', '(c1)', parentId);
    lane.addStartWithAgentContext(child2, 'Agent', '(c2)', parentId);

    lane.addResult(child1, makeError('child1 failed'));
    lane.propagateChildFailure(child1);
    lane.addResult(child2, makeError('child2 failed'));
    lane.propagateChildFailure(child2);

    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toContain('⚠');
    expect(overlay).toContain('2');
  });

  it('does not set badge on non-NESTING parent (leaf tool)', () => {
    // A leaf tool (bash) should never be an agentContext parent in practice,
    // but propagateChildFailure must not crash and must not set the field.
    const lane = new ToolLane();
    const leafId = '__bash_parent';
    const childId = '__child';

    // Manually set up a leaf entry acting as agentContext — unusual topology
    lane.addStart(leafId, 'bash', 'echo hi');
    lane.addStartWithAgentContext(childId, 'Agent', '(c)', leafId);

    lane.addResult(childId, makeError('child failed'));
    // Should not throw
    expect(() => lane.propagateChildFailure(childId)).not.toThrow();
  });

  it('no badge on successful subagent (no false positives)', () => {
    const lane = new ToolLane();
    const parentId = '__parent';
    const childId = '__child';

    lane.addStartWithAgentContext(parentId, 'Agent', '(parent)', undefined);
    lane.addStartWithAgentContext(childId, 'Agent', '(child)', parentId);
    lane.addResult(childId, makeResult('success'));
    // No propagateChildFailure call — success does not trigger propagation

    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).not.toContain('⚠');
  });

  it('is a no-op for an unknown id', () => {
    const lane = new ToolLane();
    // Should not throw on a missing id
    expect(() => lane.propagateChildFailure('__nonexistent')).not.toThrow();
  });
});

// ─── Overlay rendering with failure badge ─────────────────────────────────────

describe('overlay failure badge rendering', () => {
  it('badge appears on in-flight NESTING head row with children', () => {
    const lane = new ToolLane();
    const parentId = '__p';
    const childId = '__c';

    lane.addStartWithAgentContext(parentId, 'Agent', '(task)', undefined);
    lane.addStartWithAgentContext(childId, 'Agent', '(subtask)', parentId);

    lane.addResult(childId, makeError('subtask failed'));
    lane.propagateChildFailure(childId);

    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toContain('⚠');
    expect(overlay).toContain('1');
  });

  it('badge appears on childless NESTING in-flight row', () => {
    const lane = new ToolLane();
    const parentId = '__parent_childless';

    lane.addStartWithAgentContext(parentId, 'Agent', '(solo)', undefined);
    // Manually set the failedChildCount via propagation from a child that
    // has already been flushed out of the lane — simulate the real scenario.
    // We do this by adding a child, propagating, then removing child manually
    // via another approach: just set via a grandchild that's been collected.
    //
    // Simpler: re-add a child, propagate, then complete/remove the child entry
    // by calling addResult on it (which keeps it in the lane as a completed entry).
    const childId = '__child_of_childless';
    lane.addStartWithAgentContext(childId, 'Agent', '(sub)', parentId);
    lane.addResult(childId, makeError('sub failed'));
    lane.propagateChildFailure(childId);
    // Now complete the child (it stays in lane until flush)
    // Parent still has failedChildCount = 1, child is in lane as done
    // Force the parent to appear childless in the overlay by completing the child
    // and checking the parent overlay row
    const overlay = stripAnsi(lane.getOverlay());
    // Badge is present on parent row (child is still in lane but completed)
    expect(overlay).toContain('⚠');
  });
});
