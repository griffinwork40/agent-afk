/**
 * Tests for src/telegram/reaction-map.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ReactionMap } from './reaction-map.js';

describe('ReactionMap', () => {
  let map: ReactionMap;

  beforeEach(() => {
    map = new ReactionMap(5); // small cap for eviction tests
  });

  it('stores and retrieves a mapping', () => {
    map.set(100, 42, 'session-abc');
    expect(map.get(100, 42)).toBe('session-abc');
  });

  it('returns undefined for an unknown message', () => {
    expect(map.get(100, 99)).toBeUndefined();
  });

  it('returns undefined for a different chat with the same message_id', () => {
    map.set(100, 42, 'session-abc');
    expect(map.get(200, 42)).toBeUndefined();
  });

  it('overwrites an existing entry (refresh)', () => {
    map.set(100, 42, 'session-abc');
    map.set(100, 42, 'session-xyz');
    expect(map.get(100, 42)).toBe('session-xyz');
  });

  it('evicts the oldest entry when the cap is reached', () => {
    for (let i = 0; i < 5; i++) {
      map.set(1, i, `session-${i}`);
    }
    expect(map.size).toBe(5);

    // Adding a 6th entry should evict message_id=0
    map.set(1, 5, 'session-5');
    expect(map.size).toBe(5);
    expect(map.get(1, 0)).toBeUndefined(); // evicted
    expect(map.get(1, 5)).toBe('session-5'); // newest retained
  });

  it('does not evict when refreshing an existing key', () => {
    for (let i = 0; i < 5; i++) {
      map.set(1, i, `session-${i}`);
    }
    // Refresh the oldest key — should not trigger eviction
    map.set(1, 0, 'session-0-refreshed');
    expect(map.size).toBe(5);
    expect(map.get(1, 0)).toBe('session-0-refreshed');
  });

  it('clear() removes all entries', () => {
    map.set(1, 1, 'session-a');
    map.set(1, 2, 'session-b');
    map.clear();
    expect(map.size).toBe(0);
    expect(map.get(1, 1)).toBeUndefined();
  });
});
