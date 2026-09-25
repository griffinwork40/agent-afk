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

    // Both the root row AND the nested parent row must carry the badge —
    // asserting per-row, not "somewhere in the overlay", so a badge missing
    // from the recursive renderOverlayChildren path fails this test.
    const rows = stripAnsi(lane.getOverlay()).split('\n');
    const grandRow = rows.find((r) => r.includes('Agent(grand)'));
    const parentRow = rows.find((r) => r.includes('Agent(parent)'));
    expect(grandRow).toContain('⚠ 1');
    expect(parentRow).toContain('⚠ 1');
    // The failed leaf itself carries its own ✗ outcome, not an ancestor badge.
    const childRow = rows.find((r) => r.includes('Agent(child)'));
    expect(childRow).not.toContain('⚠');
  });

  it('badge appears on a nested headerEmitted anchor row', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('__g', 'Agent', '(grand)', undefined);
    lane.addStartWithAgentContext('__p', 'Agent', '(parent)', '__g');
    lane.addStartWithAgentContext('__c', 'Agent', '(child)', '__p');
    lane.addResult('__c', makeError('boom'));
    lane.propagateChildFailure('__c');
    // Simulate the parent's labeled header having been committed to scrollback.
    const parent = (lane as unknown as { entries: Map<string, { headerEmitted?: boolean }> }).entries.get('__p');
    expect(parent).toBeDefined();
    parent!.headerEmitted = true;

    const rows = stripAnsi(lane.getOverlay()).split('\n');
    // Two badged rows: the root and the nested (possibly anonymous) parent anchor.
    expect(rows.filter((r) => r.includes('⚠ 1')).length).toBe(2);
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

    // Assert on the parent ROW, not the whole overlay: the child label
    // `(c2)` already contains a '2', so an overlay-wide toContain('2') would
    // pass with no badge at all.
    const rows = stripAnsi(lane.getOverlay()).split('\n');
    const parentRow = rows.find((r) => r.includes('Agent(parent)'));
    expect(parentRow).toContain('⚠ 2');
  });

  it('counts a failure once when it is signalled twice for the same entry', () => {
    // A mid-run subagent failure reaches the renderer as BOTH the subagent
    // 'error' event and the dispatch's own isError tool_result.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('__parent', 'Agent', '(parent)', undefined);
    lane.addStartWithAgentContext('__child', 'Agent', '(child)', '__parent');
    lane.addResult('__child', makeError('boom'));
    lane.propagateChildFailure('__child');
    lane.propagateChildFailure('__child');

    const rows = stripAnsi(lane.getOverlay()).split('\n');
    const parentRow = rows.find((r) => r.includes('Agent(parent)'));
    expect(parentRow).toContain('⚠ 1');
    expect(parentRow).not.toContain('⚠ 2');
  });

  it('does not bubble a failed leaf tool inside a subagent', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('__parent', 'Agent', '(parent)', undefined);
    lane.addStartWithAgentContext('__bash', 'bash', 'false', '__parent');
    lane.addResult('__bash', makeError('exit 1'));
    lane.propagateChildFailure('__bash');

    expect(stripAnsi(lane.getOverlay())).not.toContain('⚠');
  });

  it('does not bubble a failed background-job control call', () => {
    // cancel_background_job is in SUBAGENT_TOOLS (so NESTING_TOOLS) but
    // dispatches nothing; its failure is not a failed descendant agent.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('__parent', 'Agent', '(parent)', undefined);
    lane.addStartWithAgentContext('__cancel', 'cancel_background_job', '{}', '__parent');
    lane.addResult('__cancel', makeError('job already finished'));
    lane.propagateChildFailure('__cancel');

    expect(stripAnsi(lane.getOverlay())).not.toContain('⚠');
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
    const leaf = (lane as unknown as { entries: Map<string, { failedChildCount?: number }> }).entries.get(leafId);
    expect(leaf?.failedChildCount).toBeUndefined();
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

    const rows = stripAnsi(lane.getOverlay()).split('\n');
    const headRow = rows.find((r) => r.includes('Agent(task)'));
    expect(headRow).toContain('⚠ 1');
  });

  it('badge appears on childless NESTING in-flight row', () => {
    // Pins the CHILDLESS, not-yet-committed branch of renderToolLaneOverlay
    // (the has-children branch is covered above). A normal flushSource of
    // the failed child marks the parent headerEmitted, and a headerEmitted
    // childless NESTING row renders nothing in the overlay, so this branch
    // is reached only when the failed child left the lane without committing
    // the parent's header. Simulate that by dropping the child entry
    // directly after the failure has been counted.
    const lane = new ToolLane();
    const parentId = '__parent_childless';
    const childId = '__child_of_childless';

    lane.addStartWithAgentContext(parentId, 'Agent', '(solo)', undefined);
    lane.addStartWithAgentContext(childId, 'Agent', '(sub)', parentId);
    lane.addResult(childId, makeError('sub failed'));
    lane.propagateChildFailure(childId);
    (lane as unknown as { entries: Map<string, unknown> }).entries.delete(childId);

    const rows = stripAnsi(lane.getOverlay()).split('\n');
    expect(rows.some((r) => r.includes('Agent(sub)'))).toBe(false);
    const soloRow = rows.find((r) => r.includes('Agent(solo)'));
    // The childless in-flight row carries the ' …' tail; the has-children
    // head row does not, so this pins the branch under test.
    expect(soloRow).toContain('…');
    expect(soloRow).toContain('⚠ 1');
  });
});
