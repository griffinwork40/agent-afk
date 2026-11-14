/**
 * Tests for the exported `flush` function in tool-lane.flush.ts.
 *
 * Verifies that flush() via ToolLane.flush() (which delegates to the
 * extracted helper) produces the same scrollback as the prior inline
 * implementation, and that the lane is fully reset afterward.
 */

import { describe, it, expect } from 'vitest';
import { ToolLane } from './tool-lane.js';
import { stripAnsi } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';

describe('flush() — exported helper (delegated from ToolLane.flush)', () => {
  it('returns empty array when lane is empty', () => {
    const lane = new ToolLane();
    expect(lane.flush()).toEqual([]);
  });

  it('renders a single leaf tool and clears the lane', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'Read', '("foo.ts")');
    lane.addResult('t1', {
      type: 'tool_result',
      toolUseId: 't1',
      content: '10 lines',
      isError: false,
    });

    const lines = lane.flush();
    expect(lines.length).toBeGreaterThan(0);
    expect(stripAnsi(lines.join('\n'))).toContain('Read');

    // Lane is fully reset after flush.
    expect(lane.flush()).toEqual([]);
  });

  it('renders multiple leaf tools and clears the lane', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'Read', '("a.ts")');
    lane.addStart('t2', 'Grep', '("foo")');
    lane.addResult('t1', { type: 'tool_result', toolUseId: 't1', content: 'a', isError: false });
    lane.addResult('t2', { type: 'tool_result', toolUseId: 't2', content: 'b', isError: false });

    const out = stripAnsi(lane.flush().join('\n'));
    expect(out).toContain('Read');
    expect(out).toContain('Grep');
    expect(lane.flush()).toEqual([]);
  });

  it('calling flush twice returns empty on the second call', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'Bash', '("echo hi")');
    lane.addResult('t1', { type: 'tool_result', toolUseId: 't1', content: 'hi', isError: false });

    const first = lane.flush();
    const second = lane.flush();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
  });

  it('flush includes in-flight (no result) entries unlike flushCompletedRoots', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'Read', '("a.ts")');
    // No addResult — entry is in-flight.

    const completedLines = lane.flushCompletedRoots();
    expect(completedLines).toEqual([]);

    // flush() commits everything including in-flight.
    lane.addStart('t2', 'Read', '("b.ts")'); // add another so lane is non-empty
    const allLines = lane.flush();
    expect(allLines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// flushCompletedRoots — orphan scenario (#4353)
// ---------------------------------------------------------------------------

describe('flushCompletedRoots() — orphan scenario: in-flight sibling survives flush', () => {
  function res(id: string): ToolResultChunk {
    return { type: 'tool_result', toolUseId: id, content: 'done', isError: false };
  }

  it('completed root is committed; in-flight sibling stays in the lane', () => {
    const lane = new ToolLane();
    // t1: completed root; t2: in-flight root.
    lane.addStart('t1', 'Read', '("a.ts")');
    lane.addStart('t2', 'Grep', '("pattern")');
    lane.addResult('t1', res('t1'));

    const lines = lane.flushCompletedRoots();
    // t1 must appear in the committed scrollback.
    expect(stripAnsi(lines.join('\n'))).toContain('Read');
    // t2 (in-flight) must still be in the lane: a second flush returns it.
    const remaining = lane.flush();
    expect(stripAnsi(remaining.join('\n'))).toContain('Grep');
  });

  it('orphan guard: tool events arriving after flushCompletedRoots absorbed a root are dropped', () => {
    const lane = new ToolLane();
    // agent1 is the nesting root; child1 belongs to it.
    lane.addStartWithAgentContext('agent1', 'Agent', '(outer)', undefined);
    lane.addStartWithAgentContext('child1', 'Read', '("x.ts")', 'agent1');
    lane.addResult('child1', res('child1'));
    lane.addResult('agent1', res('agent1'));

    // flushCompletedRoots absorbs agent1 and child1 into scrollback.
    const flushed = lane.flushCompletedRoots();
    expect(stripAnsi(flushed.join('\n'))).toContain('Agent');

    // A late-arriving tool event for agent1's context must be silently dropped
    // (agent1 is now in absorbedIds) rather than creating an orphan root.
    lane.addStartWithAgentContext('late', 'Bash', '("ls")', 'agent1');
    expect(lane.isAbsorbed('agent1')).toBe(true);

    // The lane should produce nothing further — the late entry was dropped.
    const after = lane.flush();
    expect(stripAnsi(after.join('\n'))).not.toContain('Bash');
  });

  it('returns empty when all roots are still in-flight', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'Read', '("a.ts")');
    lane.addStart('t2', 'Bash', '("ls")');
    // No results — both in-flight.
    expect(lane.flushCompletedRoots()).toEqual([]);
    // Both still in the lane.
    const remaining = lane.flush();
    expect(stripAnsi(remaining.join('\n'))).toContain('Read');
    expect(stripAnsi(remaining.join('\n'))).toContain('Bash');
  });
});

// ---------------------------------------------------------------------------
// addResult on a silently-dropped entry (#4353)
// ---------------------------------------------------------------------------

describe('addResult() — silently-dropped entry (absorbed agentContext)', () => {
  function res(id: string): ToolResultChunk {
    return { type: 'tool_result', toolUseId: id, content: 'ok', isError: false };
  }

  it('addResult for a never-registered id is a no-op (does not throw)', () => {
    const lane = new ToolLane();
    // No addStart — calling addResult on an unknown id must be safe.
    expect(() => lane.addResult('unknown', res('unknown'))).not.toThrow();
    // Lane remains empty.
    expect(lane.flush()).toEqual([]);
  });

  it('addResult for an entry dropped by the absorbed-id guard is a no-op', () => {
    const lane = new ToolLane();
    // Set up an agent that gets flushed, absorbing its id.
    lane.addStartWithAgentContext('agent1', 'Agent', '(parent)', undefined);
    lane.addResult('agent1', res('agent1'));
    lane.flushCompletedRoots(); // absorbs agent1

    // A late addStartWithAgentContext for agent1's context is dropped.
    lane.addStartWithAgentContext('late', 'Read', '("z.ts")', 'agent1');
    // Corresponding addResult must also be safe even though no entry was created.
    expect(() => lane.addResult('late', res('late'))).not.toThrow();
    // Lane is empty — the dropped entry produces nothing.
    expect(lane.flush()).toEqual([]);
  });
});
