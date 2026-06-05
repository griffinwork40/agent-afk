/**
 * Tests for AbortGraph: parent→descendant propagation, child→parent notification,
 * dispose semantics, and cascade reason threading.
 */

import { describe, it, expect, vi } from 'vitest';
import { AbortGraph } from './abort-graph.js';

function ctl(): AbortController {
  return new AbortController();
}

describe('AbortGraph', () => {
  it('propagates parent abort to all descendants synchronously', async () => {
    const graph = new AbortGraph();
    const parent = ctl();
    const childA = ctl();
    const childB = ctl();
    const grandchild = ctl();

    graph.register('p', parent);
    graph.register('a', childA);
    graph.register('b', childB);
    graph.register('g', grandchild);
    graph.linkChild('p', 'a');
    graph.linkChild('p', 'b');
    graph.linkChild('a', 'g');

    graph.abort('p', 'parent-reason');

    // Flush microtasks
    await Promise.resolve();

    expect(parent.signal.aborted).toBe(true);
    expect(childA.signal.aborted).toBe(true);
    expect(childB.signal.aborted).toBe(true);
    expect(grandchild.signal.aborted).toBe(true);
    expect(parent.signal.reason).toBe('parent-reason');
    expect(childA.signal.reason).toBe('parent-reason');
    expect(grandchild.signal.reason).toBe('parent-reason');
  });

  it('notifies parent listener when a child aborts externally and does NOT auto-abort parent', () => {
    const graph = new AbortGraph();
    const parent = ctl();
    const child = ctl();
    graph.register('p', parent);
    graph.register('c', child);
    graph.linkChild('p', 'c');

    const listener = vi.fn();
    graph.onChildAborted('p', listener);

    graph.abort('c', 'child-failure');

    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      parentId: 'p',
      childId: 'c',
      reason: 'child-failure',
    });
  });

  it('suppresses parent notification when child aborts via cascade', async () => {
    const graph = new AbortGraph();
    const parent = ctl();
    const child = ctl();
    const grandchild = ctl();
    graph.register('p', parent);
    graph.register('c', child);
    graph.register('g', grandchild);
    graph.linkChild('p', 'c');
    graph.linkChild('c', 'g');

    const parentListener = vi.fn();
    const childListener = vi.fn();
    graph.onChildAborted('p', parentListener);
    graph.onChildAborted('c', childListener);

    graph.abort('p', 'shutdown');
    await Promise.resolve();

    // No one should be notified — all aborts are cascades of the root 'p' abort
    expect(parentListener).not.toHaveBeenCalled();
    expect(childListener).not.toHaveBeenCalled();
  });

  it('linking a child under an already-aborted parent aborts the child immediately', () => {
    const graph = new AbortGraph();
    const parent = ctl();
    const child = ctl();
    graph.register('p', parent);
    graph.abort('p', 'pre-aborted');
    graph.register('c', child);
    graph.linkChild('p', 'c');

    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('pre-aborted');
  });

  it('dispose removes node without aborting and orphans descendants', () => {
    const graph = new AbortGraph();
    const parent = ctl();
    const child = ctl();
    const grandchild = ctl();
    graph.register('p', parent);
    graph.register('c', child);
    graph.register('g', grandchild);
    graph.linkChild('p', 'c');
    graph.linkChild('c', 'g');

    graph.dispose('c');

    expect(child.signal.aborted).toBe(false);
    expect(graph.has('c')).toBe(false);
    expect(graph.has('g')).toBe(true);

    // After dispose, aborting parent must not affect the orphaned grandchild (lost parent link via dispose).
    graph.abort('p');
    expect(parent.signal.aborted).toBe(true);
    expect(grandchild.signal.aborted).toBe(false);
  });

  it('unsubscribe stops further child-abort notifications', () => {
    const graph = new AbortGraph();
    const parent = ctl();
    const child1 = ctl();
    const child2 = ctl();
    graph.register('p', parent);
    graph.register('c1', child1);
    graph.register('c2', child2);
    graph.linkChild('p', 'c1');
    graph.linkChild('p', 'c2');

    const listener = vi.fn();
    const unsubscribe = graph.onChildAborted('p', listener);

    graph.abort('c1', 'first');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    graph.abort('c2', 'second');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('abort is idempotent', () => {
    const graph = new AbortGraph();
    const c = ctl();
    graph.register('x', c);
    graph.abort('x', 'first');
    graph.abort('x', 'second');
    // Reason from first abort is preserved
    expect(c.signal.reason).toBe('first');
  });

  it('linkChild throws for unknown parent or child', () => {
    const graph = new AbortGraph();
    graph.register('p', ctl());
    expect(() => graph.linkChild('p', 'nope')).toThrow(/child nope not registered/);
    expect(() => graph.linkChild('nope', 'p')).toThrow(/parent nope not registered/);
  });
});
