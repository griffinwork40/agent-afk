/**
 * Tests for the LRU CompletedCache.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CompletedCache } from './completed-cache.js';
import type { SubagentHandle } from './handle.js';
import type { SubagentResult } from './result.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeHandle(id: string): SubagentHandle {
  return { id } as unknown as SubagentHandle;
}

function makeResult(): SubagentResult {
  return { status: 'succeeded', value: null } as unknown as SubagentResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompletedCache', () => {
  let cache: CompletedCache;

  beforeEach(() => {
    cache = new CompletedCache(3); // capacity = 3
  });

  // -------------------------------------------------------------------------
  // Basic add / get / size
  // -------------------------------------------------------------------------

  it('starts empty', () => {
    expect(cache.size).toBe(0);
    expect(cache.list()).toHaveLength(0);
  });

  it('add and get a single entry', () => {
    const h = makeHandle('a');
    const r = makeResult();
    cache.add('a', h, r);
    const entry = cache.get('a');
    expect(entry).toBeDefined();
    expect(entry!.handle).toBe(h);
    expect(entry!.result).toBe(r);
    expect(typeof entry!.completedAt).toBe('number');
    expect(cache.size).toBe(1);
  });

  it('get returns undefined for unknown id', () => {
    expect(cache.get('nope')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // list returns newest first
  // -------------------------------------------------------------------------

  it('list returns entries newest-first', () => {
    cache.add('a', makeHandle('a'), makeResult());
    cache.add('b', makeHandle('b'), makeResult());
    cache.add('c', makeHandle('c'), makeResult());
    const ids = cache.list().map(e => e.handle.id);
    expect(ids).toEqual(['c', 'b', 'a']);
  });

  // -------------------------------------------------------------------------
  // LRU eviction at capacity boundary
  // -------------------------------------------------------------------------

  it('evicts oldest when capacity is exceeded', () => {
    cache.add('a', makeHandle('a'), makeResult());
    cache.add('b', makeHandle('b'), makeResult());
    cache.add('c', makeHandle('c'), makeResult());
    // Capacity is 3 — adding a 4th evicts 'a' (oldest)
    cache.add('d', makeHandle('d'), makeResult());
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('evicts multiple oldest entries when adding to a full+over cache', () => {
    // capacity = 3; add 5 → 'a' and 'b' should be gone
    cache.add('a', makeHandle('a'), makeResult());
    cache.add('b', makeHandle('b'), makeResult());
    cache.add('c', makeHandle('c'), makeResult());
    cache.add('d', makeHandle('d'), makeResult());
    cache.add('e', makeHandle('e'), makeResult());
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
    expect(cache.get('e')).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Re-adding moves to most-recent
  // -------------------------------------------------------------------------

  it('re-adding an existing id moves it to most-recent position', () => {
    cache.add('a', makeHandle('a'), makeResult());
    cache.add('b', makeHandle('b'), makeResult());
    cache.add('c', makeHandle('c'), makeResult());
    // Re-add 'a' — it should become newest
    const aHandle = makeHandle('a-updated');
    cache.add('a', aHandle, makeResult());
    // Now cache is: b, c, a (newest last in Map = 'a' shows first in list())
    expect(cache.size).toBe(3);
    const ids = cache.list().map(e => e.handle.id);
    expect(ids[0]).toBe('a-updated');  // newest
  });

  it('re-adding does not cause eviction when capacity not exceeded', () => {
    cache.add('a', makeHandle('a'), makeResult());
    cache.add('b', makeHandle('b'), makeResult());
    // Re-add 'a' while under capacity → no eviction
    cache.add('a', makeHandle('a-v2'), makeResult());
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeDefined();
  });

  it('re-adding oldest prevents its eviction', () => {
    cache.add('a', makeHandle('a'), makeResult());
    cache.add('b', makeHandle('b'), makeResult());
    cache.add('c', makeHandle('c'), makeResult());
    // Touch 'a' to make it newest
    cache.add('a', makeHandle('a'), makeResult());
    // Add 'd' — should evict 'b' (now oldest) rather than 'a'
    cache.add('d', makeHandle('d'), makeResult());
    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // delete / clear
  // -------------------------------------------------------------------------

  it('delete removes an entry and returns true', () => {
    cache.add('a', makeHandle('a'), makeResult());
    expect(cache.delete('a')).toBe(true);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('delete returns false for missing id', () => {
    expect(cache.delete('ghost')).toBe(false);
  });

  it('clear removes all entries', () => {
    cache.add('a', makeHandle('a'), makeResult());
    cache.add('b', makeHandle('b'), makeResult());
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.list()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Capacity = 1 edge case
  // -------------------------------------------------------------------------

  it('capacity-1 cache always holds only the last entry', () => {
    const tiny = new CompletedCache(1);
    tiny.add('x', makeHandle('x'), makeResult());
    tiny.add('y', makeHandle('y'), makeResult());
    expect(tiny.size).toBe(1);
    expect(tiny.get('x')).toBeUndefined();
    expect(tiny.get('y')).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // recordHandle — convenience method used by SubagentManager.forkSubagent
  // -------------------------------------------------------------------------

  it('recordHandle succeeded — builds a result with status=succeeded and no error', () => {
    const h = makeHandle('s1');
    const trace = { toolCalls: [], toolResults: [], thinkingPresent: false, turnCount: 2 };
    cache.recordHandle('s1', h, 'succeeded', trace, undefined);
    const entry = cache.get('s1');
    expect(entry).toBeDefined();
    expect(entry!.handle).toBe(h);
    expect(entry!.result.status).toBe('succeeded');
    expect(entry!.result.error).toBeUndefined();
    expect(entry!.result.trace).toBe(trace);
    expect(entry!.result.stopReason).toBeUndefined();
  });

  it('recordHandle succeeded — attaches stopReason when provided', () => {
    const h = makeHandle('s2');
    const trace = { toolCalls: [], toolResults: [], thinkingPresent: false, turnCount: 1 };
    cache.recordHandle('s2', h, 'succeeded', trace, 'tool_use_loop_capped');
    const entry = cache.get('s2');
    expect(entry!.result.stopReason).toBe('tool_use_loop_capped');
  });

  it('recordHandle failed — builds a result with status=failed and an error', () => {
    const h = makeHandle('f1');
    const trace = { toolCalls: [], toolResults: [], thinkingPresent: false, turnCount: 0 };
    cache.recordHandle('f1', h, 'failed', trace, undefined);
    const entry = cache.get('f1');
    expect(entry).toBeDefined();
    expect(entry!.result.status).toBe('failed');
    expect(entry!.result.error).toBeInstanceOf(Error);
  });

  it('recordHandle cancelled — records the entry with status=cancelled', () => {
    const h = makeHandle('c1');
    const trace = { toolCalls: [], toolResults: [], thinkingPresent: false, turnCount: 0 };
    cache.recordHandle('c1', h, 'cancelled', trace, undefined);
    const entry = cache.get('c1');
    expect(entry).toBeDefined();
    expect(entry!.result.status).toBe('cancelled');
  });
});
