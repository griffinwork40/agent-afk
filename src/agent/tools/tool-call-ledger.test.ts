/**
 * Unit tests for ToolCallLedger.
 *
 * Contract: every public method and every documented invariant gets at least
 * one test. Boundary conditions (turn-window edge, key cap, empty state) are
 * covered before the happy paths so regressions are caught at the tightest
 * definition of "working".
 *
 * Covers:
 *   - constructor: valid and invalid turnWindow values
 *   - record / lookup: basic round-trip
 *   - lookup: window boundary (inclusive lower bound, exclusive below it)
 *   - lookup: empty result when key absent
 *   - lookup: multiple entries for same key accumulate in order
 *   - lookup: entries outside window are filtered but not deleted until prune
 *   - prune: removes stale buckets, keeps live ones
 *   - prune: no-op on empty ledger
 *   - prune: bucket with mixed-age entries pruned only when latestTurn is stale
 *   - keyCount / entryCount diagnostics
 *   - rawEntryCountFor: counts across window boundary
 *   - MAX_LEDGER_KEYS cap: new keys silently dropped, existing keys still updated
 *   - compositeKey collision safety: same hash different tool ≠ same key
 *   - DEFAULT_TURN_WINDOW constant sanity
 *
 * @module agent/tools/tool-call-ledger.test
 */

import { describe, it, expect } from 'vitest';
import {
  ToolCallLedger,
  DEFAULT_TURN_WINDOW,
  MAX_LEDGER_KEYS,
} from './tool-call-ledger.js';
import type { ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(content = 'ok'): ToolResult {
  return { content, isError: false };
}

function err(content = 'ECONNREFUSED'): ToolResult {
  return { content, isError: true };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('DEFAULT_TURN_WINDOW is a positive integer', () => {
    expect(Number.isInteger(DEFAULT_TURN_WINDOW)).toBe(true);
    expect(DEFAULT_TURN_WINDOW).toBeGreaterThan(0);
  });

  it('MAX_LEDGER_KEYS is a positive integer', () => {
    expect(Number.isInteger(MAX_LEDGER_KEYS)).toBe(true);
    expect(MAX_LEDGER_KEYS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('uses DEFAULT_TURN_WINDOW when no argument supplied', () => {
    const ledger = new ToolCallLedger();
    // Record at turn 0, lookup at turn DEFAULT_TURN_WINDOW — still inside window
    ledger.record('bash', 'h1', ok(), 0);
    expect(ledger.lookup('bash', 'h1', DEFAULT_TURN_WINDOW)).toHaveLength(1);
    // Lookup at turn DEFAULT_TURN_WINDOW + 1 — now outside window
    expect(ledger.lookup('bash', 'h1', DEFAULT_TURN_WINDOW + 1)).toHaveLength(0);
  });
  it('accepts a valid positive integer window', () => {
    expect(() => new ToolCallLedger(5)).not.toThrow();
    expect(() => new ToolCallLedger(1)).not.toThrow();
    expect(() => new ToolCallLedger(100)).not.toThrow();
  });

  it('uses DEFAULT_TURN_WINDOW when no argument supplied', () => {
    const ledger = new ToolCallLedger();
    // Record at turn 0, lookup at turn DEFAULT_TURN_WINDOW — still inside window
    ledger.record('bash', 'h1', ok(), 0);
    expect(ledger.lookup('bash', 'h1', DEFAULT_TURN_WINDOW)).toHaveLength(1);
    // Lookup at turn DEFAULT_TURN_WINDOW + 1 — now outside window
    expect(ledger.lookup('bash', 'h1', DEFAULT_TURN_WINDOW + 1)).toHaveLength(0);
  });

  it('throws RangeError for zero turnWindow', () => {
    expect(() => new ToolCallLedger(0)).toThrow(RangeError);
  });

  it('throws RangeError for negative turnWindow', () => {
    expect(() => new ToolCallLedger(-1)).toThrow(RangeError);
  });

  it('throws RangeError for non-integer turnWindow', () => {
    expect(() => new ToolCallLedger(2.5)).toThrow(RangeError);
    expect(() => new ToolCallLedger(NaN)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// record — turnIndex validation
// ---------------------------------------------------------------------------

describe('record — turnIndex validation', () => {
  it('throws RangeError for negative turnIndex', () => {
    const ledger = new ToolCallLedger(10);
    expect(() => ledger.record('bash', 'h1', ok(), -1)).toThrow(RangeError);
    expect(() => ledger.record('bash', 'h1', ok(), -0.5)).toThrow(RangeError);
  });

  it('throws RangeError for NaN turnIndex', () => {
    const ledger = new ToolCallLedger(10);
    expect(() => ledger.record('bash', 'h1', ok(), NaN)).toThrow(RangeError);
  });

  it('throws RangeError for Infinity turnIndex', () => {
    const ledger = new ToolCallLedger(10);
    expect(() => ledger.record('bash', 'h1', ok(), Infinity)).toThrow(RangeError);
    expect(() => ledger.record('bash', 'h1', ok(), -Infinity)).toThrow(RangeError);
  });

  it('accepts turnIndex of 0', () => {
    const ledger = new ToolCallLedger(10);
    expect(() => ledger.record('bash', 'h1', ok(), 0)).not.toThrow();
  });

  it('accepts large positive turnIndex', () => {
    const ledger = new ToolCallLedger(10);
    expect(() => ledger.record('bash', 'h1', ok(), 999_999)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// record / lookup — basic round-trip
// ---------------------------------------------------------------------------

describe('record + lookup', () => {
  it('returns empty array for an unknown key', () => {
    const ledger = new ToolCallLedger(10);
    expect(ledger.lookup('bash', 'nonexistent', 5)).toEqual([]);
  });

  it('round-trips a single entry', () => {
    const ledger = new ToolCallLedger(10);
    const result = ok('hello');
    ledger.record('bash', 'h1', result, 3);
    const history = ledger.lookup('bash', 'h1', 3);
    expect(history).toHaveLength(1);
    expect(history[0]?.result).toEqual(result);
    expect(history[0]?.turnIndex).toBe(3);
  });

  it('accumulates multiple entries for the same key in recording order', () => {
    const ledger = new ToolCallLedger(10);
    ledger.record('bash', 'h1', err('first'), 1);
    ledger.record('bash', 'h1', ok('second'), 2);
    ledger.record('bash', 'h1', err('third'), 3);
    const history = ledger.lookup('bash', 'h1', 3);
    expect(history).toHaveLength(3);
    expect(history[0]?.result.content).toBe('first');
    expect(history[1]?.result.content).toBe('second');
    expect(history[2]?.result.content).toBe('third');
  });

  it('distinguishes different tools with the same inputHash', () => {
    const ledger = new ToolCallLedger(10);
    ledger.record('bash', 'hash', ok('bash result'), 1);
    ledger.record('read_file', 'hash', err('read error'), 1);
    expect(ledger.lookup('bash', 'hash', 1)).toHaveLength(1);
    expect(ledger.lookup('read_file', 'hash', 1)).toHaveLength(1);
    expect(ledger.lookup('bash', 'hash', 1)[0]?.result.content).toBe('bash result');
    expect(ledger.lookup('read_file', 'hash', 1)[0]?.result.content).toBe('read error');
  });

  it('distinguishes same tool with different inputHash', () => {
    const ledger = new ToolCallLedger(10);
    ledger.record('bash', 'hash-a', ok('a'), 1);
    ledger.record('bash', 'hash-b', ok('b'), 1);
    expect(ledger.lookup('bash', 'hash-a', 1)[0]?.result.content).toBe('a');
    expect(ledger.lookup('bash', 'hash-b', 1)[0]?.result.content).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Turn-window filtering in lookup
// ---------------------------------------------------------------------------

describe('lookup — window boundary', () => {
  it('includes entries exactly at the window boundary (currentTurn - turnWindow)', () => {
    // turnWindow=5, currentTurn=10 → cutoff=5; turnIndex=5 is included
    const ledger = new ToolCallLedger(5);
    ledger.record('bash', 'h1', ok(), 5);
    expect(ledger.lookup('bash', 'h1', 10)).toHaveLength(1);
  });

  it('excludes entries one turn below the boundary', () => {
    // turnWindow=5, currentTurn=10 → cutoff=5; turnIndex=4 is excluded
    const ledger = new ToolCallLedger(5);
    ledger.record('bash', 'h1', ok(), 4);
    expect(ledger.lookup('bash', 'h1', 10)).toHaveLength(0);
  });

  it('filters mixed-age entries correctly', () => {
    // turnWindow=5, currentTurn=10 → cutoff=5
    const ledger = new ToolCallLedger(5);
    ledger.record('bash', 'h1', err('old'), 4);   // stale
    ledger.record('bash', 'h1', ok('boundary'), 5); // at boundary — kept
    ledger.record('bash', 'h1', ok('fresh'), 8);   // well inside — kept
    const history = ledger.lookup('bash', 'h1', 10);
    expect(history).toHaveLength(2);
    expect(history[0]?.result.content).toBe('boundary');
    expect(history[1]?.result.content).toBe('fresh');
  });

  it('outside-window entries still count in rawEntryCountFor before prune', () => {
    const ledger = new ToolCallLedger(5);
    ledger.record('bash', 'h1', err('old'), 1);
    ledger.record('bash', 'h1', ok('new'), 10);
    // lookup at turn 10: window cutoff = 5; turn 1 is stale, turn 10 is live
    expect(ledger.lookup('bash', 'h1', 10)).toHaveLength(1);
    // but raw count includes the stale entry
    expect(ledger.rawEntryCountFor('bash', 'h1')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe('prune', () => {
  it('is a no-op on an empty ledger', () => {
    const ledger = new ToolCallLedger(5);
    expect(() => ledger.prune(100)).not.toThrow();
    expect(ledger.keyCount).toBe(0);
  });

  it('removes buckets whose latestTurn is strictly below the cutoff', () => {
    // turnWindow=5, prune at currentTurn=10 → cutoff=5; latestTurn=4 is stale
    const ledger = new ToolCallLedger(5);
    ledger.record('bash', 'h1', err(), 4);
    expect(ledger.keyCount).toBe(1);
    ledger.prune(10);
    expect(ledger.keyCount).toBe(0);
  });

  it('keeps buckets whose latestTurn equals the cutoff', () => {
    // turnWindow=5, prune at currentTurn=10 → cutoff=5; latestTurn=5 is live
    const ledger = new ToolCallLedger(5);
    ledger.record('bash', 'h1', ok(), 5);
    ledger.prune(10);
    expect(ledger.keyCount).toBe(1);
  });

  it('keeps buckets whose latestTurn is above the cutoff', () => {
    const ledger = new ToolCallLedger(5);
    ledger.record('bash', 'h1', ok(), 8);
    ledger.prune(10);
    expect(ledger.keyCount).toBe(1);
  });

  it('prunes only stale buckets, keeping live ones', () => {
    const ledger = new ToolCallLedger(5);
    // stale: latestTurn=2, cutoff=5
    ledger.record('bash', 'stale', err(), 2);
    // live: latestTurn=6
    ledger.record('read_file', 'live', ok(), 6);
    expect(ledger.keyCount).toBe(2);
    ledger.prune(10);
    expect(ledger.keyCount).toBe(1);
    expect(ledger.lookup('read_file', 'live', 10)).toHaveLength(1);
    expect(ledger.lookup('bash', 'stale', 10)).toHaveLength(0);
  });

  it('bucket latestTurn tracks the most recent record call', () => {
    // turnWindow=5, prune at 10 → cutoff=5
    // First record at 2 (stale), then a later record at 6 (live) for same key
    // → latestTurn=6 → bucket should survive
    const ledger = new ToolCallLedger(5);
    ledger.record('bash', 'h1', err(), 2);
    ledger.record('bash', 'h1', ok(), 6);
    ledger.prune(10);
    expect(ledger.keyCount).toBe(1);
  });

  it('after prune, entryCount reflects removal', () => {
    const ledger = new ToolCallLedger(5);
    ledger.record('bash', 'a', err(), 1); // stale at prune(10)
    ledger.record('bash', 'b', ok(), 8); // live
    expect(ledger.entryCount).toBe(2);
    ledger.prune(10);
    expect(ledger.entryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics: keyCount / entryCount / rawEntryCountFor
// ---------------------------------------------------------------------------

describe('diagnostics', () => {
  it('keyCount starts at 0', () => {
    expect(new ToolCallLedger().keyCount).toBe(0);
  });

  it('keyCount increments for each new (tool, hash) pair', () => {
    const ledger = new ToolCallLedger();
    ledger.record('bash', 'h1', ok(), 1);
    ledger.record('bash', 'h2', ok(), 1);
    ledger.record('read_file', 'h1', ok(), 1);
    expect(ledger.keyCount).toBe(3);
  });

  it('repeated records for same key do not increment keyCount', () => {
    const ledger = new ToolCallLedger();
    ledger.record('bash', 'h1', ok(), 1);
    ledger.record('bash', 'h1', err(), 2);
    expect(ledger.keyCount).toBe(1);
  });

  it('entryCount starts at 0', () => {
    expect(new ToolCallLedger().entryCount).toBe(0);
  });

  it('entryCount sums all observations across all keys', () => {
    const ledger = new ToolCallLedger();
    ledger.record('bash', 'h1', ok(), 1);
    ledger.record('bash', 'h1', err(), 2);
    ledger.record('read_file', 'h2', ok(), 3);
    expect(ledger.entryCount).toBe(3);
  });

  it('rawEntryCountFor returns 0 for unknown key', () => {
    expect(new ToolCallLedger().rawEntryCountFor('bash', 'nope')).toBe(0);
  });

  it('rawEntryCountFor counts all entries regardless of window', () => {
    const ledger = new ToolCallLedger(2);
    ledger.record('bash', 'h1', err(), 1);
    ledger.record('bash', 'h1', err(), 2);
    ledger.record('bash', 'h1', err(), 3);
    // lookup at currentTurn=10 excludes turn 1 and 2 (cutoff=8), but raw count is 3
    expect(ledger.rawEntryCountFor('bash', 'h1')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// MAX_LEDGER_KEYS cap
// ---------------------------------------------------------------------------

describe('MAX_LEDGER_KEYS cap', () => {
  it('drops new keys once cap is reached', () => {
    // Use a tiny custom cap via a sub-class shim — we cannot override
    // MAX_LEDGER_KEYS directly, so instead we fill up to MAX_LEDGER_KEYS with
    // unique hash values and verify that the (MAX_LEDGER_KEYS + 1)-th new key
    // is silently dropped.
    //
    // Filling 2000 slots would be slow; instead we verify the cap logic by
    // inspecting keyCount behavior after cap is reached using a spy approach:
    // we create a ledger, fill it to cap using unique hashes, then attempt to
    // add one more and confirm keyCount did not grow.
    const ledger = new ToolCallLedger(100);
    for (let i = 0; i < MAX_LEDGER_KEYS; i++) {
      ledger.record('bash', `hash-${i}`, ok(), 1);
    }
    expect(ledger.keyCount).toBe(MAX_LEDGER_KEYS);

    // One more new key — must be silently dropped
    ledger.record('bash', 'overflow-key', ok(), 1);
    expect(ledger.keyCount).toBe(MAX_LEDGER_KEYS);
    expect(ledger.lookup('bash', 'overflow-key', 1)).toHaveLength(0);
  });

  it('updates existing keys even when cap is reached', () => {
    const ledger = new ToolCallLedger(100);
    // Fill to cap
    for (let i = 0; i < MAX_LEDGER_KEYS; i++) {
      ledger.record('bash', `hash-${i}`, ok(), 1);
    }
    // Updating an already-recorded key must succeed even though cap is full
    ledger.record('bash', 'hash-0', err('updated'), 2);
    const history = ledger.lookup('bash', 'hash-0', 2);
    expect(history).toHaveLength(2);
    expect(history[1]?.result.content).toBe('updated');
  });
});

// ---------------------------------------------------------------------------
// Result immutability — returned snapshot is independent of later mutations
// ---------------------------------------------------------------------------

describe('result snapshot independence', () => {
  it('a lookup result is not affected by subsequent record calls', () => {
    const ledger = new ToolCallLedger(10);
    ledger.record('bash', 'h1', ok('first'), 1);
    const snapshot = ledger.lookup('bash', 'h1', 5);
    // Record a second entry
    ledger.record('bash', 'h1', ok('second'), 2);
    // The snapshot obtained before the second record still has only one entry
    expect(snapshot).toHaveLength(1);
    // But a fresh lookup sees both
    expect(ledger.lookup('bash', 'h1', 5)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Error result preservation
// ---------------------------------------------------------------------------

describe('error result preservation', () => {
  it('preserves isError: true on stored entries', () => {
    const ledger = new ToolCallLedger(10);
    const failure = err('something broke');
    ledger.record('git_read', 'hgit', failure, 5);
    const history = ledger.lookup('git_read', 'hgit', 5);
    expect(history[0]?.result.isError).toBe(true);
    expect(history[0]?.result.content).toBe('something broke');
  });

  it('preserves isError: false on stored entries', () => {
    const ledger = new ToolCallLedger(10);
    ledger.record('bash', 'h1', ok('good output'), 3);
    const entry = ledger.lookup('bash', 'h1', 3)[0];
    expect(entry?.result.isError).toBe(false);
    expect(entry?.result.content).toBe('good output');
  });
});
