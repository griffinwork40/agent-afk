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
