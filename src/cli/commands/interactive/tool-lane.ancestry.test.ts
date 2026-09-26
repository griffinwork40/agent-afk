/**
 * Direct unit tests for ancestorDepthOf in tool-lane.ancestry.ts.
 *
 * Uses a minimal ReadonlyMap<string, Entry> to exercise the function
 * without spinning up a full ToolLane instance.
 */

import { describe, it, expect } from 'vitest';
import { ancestorDepthOf } from './tool-lane.ancestry.js';
import type { Entry, ToolEntry } from './tool-lane-render.js';

function makeEntry(toolUseId: string, agentContext?: string): ToolEntry {
  return {
    kind: 'tool',
    toolUseId,
    toolName: 'Agent',
    toolInput: '{}',
    startedAt: Date.now(),
    agentContext,
    prefix: '',
  };
}

describe('ancestorDepthOf', () => {
  it('returns 0 for root entry (no agentContext)', () => {
    const root = makeEntry('root');
    const map: ReadonlyMap<string, Entry> = new Map([['root', root]]);
    expect(ancestorDepthOf(map, 'root')).toBe(0);
  });

  it('returns 0 for missing entry id', () => {
    const map: ReadonlyMap<string, Entry> = new Map();
    expect(ancestorDepthOf(map, 'nonexistent')).toBe(0);
  });

  it('returns 1 for a direct child', () => {
    const root = makeEntry('root');
    const child = makeEntry('child', 'root');
    const map: ReadonlyMap<string, Entry> = new Map([
      ['root', root],
      ['child', child],
    ]);
    expect(ancestorDepthOf(map, 'child')).toBe(1);
  });

  it('returns 2 for grandchild', () => {
    const root = makeEntry('root');
    const parent = makeEntry('parent', 'root');
    const grandchild = makeEntry('grandchild', 'parent');
    const map: ReadonlyMap<string, Entry> = new Map([
      ['root', root],
      ['parent', parent],
      ['grandchild', grandchild],
    ]);
    expect(ancestorDepthOf(map, 'grandchild')).toBe(2);
  });

  it('stops at a dangling agentContext (parent flushed)', () => {
    // child points to a parent that is no longer in the map
    const child = makeEntry('child', 'flushed-parent');
    const map: ReadonlyMap<string, Entry> = new Map([['child', child]]);
    // depth is 0: the parent lookup misses so the walk stops before counting
    expect(ancestorDepthOf(map, 'child')).toBe(0);
  });

  it('does not infinite-loop on a cycle', () => {
    // Create a synthetic cycle: A → B → A
    const a = makeEntry('A', 'B');
    const b = makeEntry('B', 'A');
    const map: ReadonlyMap<string, Entry> = new Map([
      ['A', a],
      ['B', b],
    ]);
    // Should terminate quickly and return a small number rather than hanging
    const depth = ancestorDepthOf(map, 'A');
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(depth).toBeLessThan(32); // well under ANCESTRY_CYCLE_CAP
  });
});
