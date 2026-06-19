/**
 * Tests for the routing-decision row builder (Stage B session identity).
 *
 * Proves, at the pure row-building layer (the writer itself no-ops under
 * vitest), that:
 *   1. top-level rows carry the correct origin + actor,
 *   2. subagent-derived rows carry actor:'subagent',
 *   3. the frozen `surface: 'afk'` provenance tag is unchanged,
 *   4. legacy rows without origin/actor stay byte-identical (fields omitted).
 */

import { describe, it, expect } from 'vitest';
import { buildRoutingDecisionRow } from './routing-telemetry.js';

describe('buildRoutingDecisionRow — session identity', () => {
  it('(1) top-level row carries origin + actor', () => {
    const row = buildRoutingDecisionRow({
      event: 'subagent.completed',
      subagent_id: 'c1',
      origin: 'daemon',
      actor: 'main',
    });
    expect(row['origin']).toBe('daemon');
    expect(row['actor']).toBe('main');
    expect(row['event']).toBe('subagent.completed');
  });

  it('(2) subagent-derived row carries actor:subagent', () => {
    const row = buildRoutingDecisionRow({
      event: 'subagent.failed',
      origin: 'cli',
      actor: 'subagent',
    });
    expect(row['actor']).toBe('subagent');
    expect(row['origin']).toBe('cli');
  });

  it('(3) surface:afk provenance tag is always present and unchanged', () => {
    const withId = buildRoutingDecisionRow({ event: 'skill.dispatched', origin: 'telegram', actor: 'main' });
    const without = buildRoutingDecisionRow({ event: 'skill.dispatched' });
    expect(withId['surface']).toBe('afk');
    expect(without['surface']).toBe('afk');
    // origin is a SEPARATE field — it never overwrites the provenance tag.
    expect(withId['origin']).toBe('telegram');
  });

  it('(4) legacy row without origin/actor omits both keys (back-compat)', () => {
    const row = buildRoutingDecisionRow({ event: 'subagent.dispatched', subagent_id: 'c2' });
    expect('origin' in row).toBe(false);
    expect('actor' in row).toBe(false);
    // Still a valid row with provenance + the event.
    expect(row['surface']).toBe('afk');
    expect(row['event']).toBe('subagent.dispatched');
  });

  it('drops explicitly-undefined origin/actor (no null leakage)', () => {
    const row = buildRoutingDecisionRow({ event: 'x', origin: undefined, actor: undefined });
    expect('origin' in row).toBe(false);
    expect('actor' in row).toBe(false);
  });
});
