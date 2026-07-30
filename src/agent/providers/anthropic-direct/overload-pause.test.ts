// Overload-exhaustion policy tests (#762): the classification arm that replaces
// the structurally-unreachable `classifyUsageLimitError` path for a status-less
// mid-stream 529, the surface-differentiated wall-clock ceiling, and the jitter
// that de-synchronizes concurrent retriers.

import { describe, it, expect, afterEach } from 'vitest';
import type { ProviderEvent } from '../../provider.js';
import {
  OVERLOAD_EXHAUSTED,
  OVERLOAD_PAUSE_CEILING_MS,
  OVERLOAD_PROBE_MIN_MS,
  OVERLOAD_PROBE_MAX_MS,
  classifyOverloadExhaustion,
  jitterBackoff,
  nextProbeDelayMs,
  resolveOverloadPauseCeilingMs,
} from './overload-pause.js';
import { classifyUsageLimitError } from './usage-limit.js';

const completed = (stopReason?: string | null): ProviderEvent => ({
  type: 'turn.completed',
  usage: { ...(stopReason !== undefined ? { stopReason } : {}) },
  sessionId: 's1',
});

describe('classifyOverloadExhaustion (the new classification arm)', () => {
  it('matches the exhaustion sentinel on a clean turn.completed', () => {
    expect(classifyOverloadExhaustion(completed(OVERLOAD_EXHAUSTED))).toBe(true);
  });

  it('does not match an ordinary completed turn', () => {
    expect(classifyOverloadExhaustion(completed('end_turn'))).toBe(false);
    expect(classifyOverloadExhaustion(completed())).toBe(false);
    expect(classifyOverloadExhaustion(completed(null))).toBe(false);
  });

  it('does not match the tool-use cap sentinel', () => {
    expect(classifyOverloadExhaustion(completed('tool_use_loop_capped'))).toBe(false);
  });

  it('does not match non-terminal events', () => {
    expect(
      classifyOverloadExhaustion({ type: 'delta.text', text: 'hi', sessionId: 's1' }),
    ).toBe(false);
    expect(
      classifyOverloadExhaustion({ type: 'error', error: new Error('Overloaded') }),
    ).toBe(false);
  });

  // The whole reason this arm exists: a mid-stream 529 is
  // `new APIError(undefined, <SSE body>, …)` with `status === undefined`, and
  // `usage-limit.ts:111` (`if (!('status' in error)) return null`) rejects it —
  // so the usage-limit pause machinery cannot classify it even in principle.
  it('covers the gap classifyUsageLimitError structurally cannot', () => {
    const midStream529 = Object.assign(new Error('Overloaded'), {
      status: undefined,
      error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });
    expect(classifyUsageLimitError(midStream529)).toBeNull();
    expect(classifyOverloadExhaustion(completed(OVERLOAD_EXHAUSTED))).toBe(true);
  });
});

describe('resolveOverloadPauseCeilingMs (surface-differentiated ceilings)', () => {
  afterEach(() => {
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });

  it('parks interactive surfaces for up to 10 minutes', () => {
    for (const s of ['cli', 'repl', 'telegram']) {
      expect(resolveOverloadPauseCeilingMs(s)).toBe(OVERLOAD_PAUSE_CEILING_MS);
    }
  });

  // The core safety property: an always-on runner that silently parks on a
  // capacity event is strictly worse than one that fails and notifies.
  it('fails fast on daemon/cron and unknown surfaces by default', () => {
    expect(resolveOverloadPauseCeilingMs('daemon')).toBe(0);
    expect(resolveOverloadPauseCeilingMs('subagent')).toBe(0);
    expect(resolveOverloadPauseCeilingMs('unknown')).toBe(0);
    expect(resolveOverloadPauseCeilingMs(undefined)).toBe(0);
  });

  it('lets AFK_OVERLOAD_PAUSE_MS opt a daemon in deliberately', () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '120000';
    expect(resolveOverloadPauseCeilingMs('daemon')).toBe(120_000);
  });

  it('lets AFK_OVERLOAD_PAUSE_MS=0 disable the pause on every surface', () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '0';
    expect(resolveOverloadPauseCeilingMs('cli')).toBe(0);
    expect(resolveOverloadPauseCeilingMs('telegram')).toBe(0);
  });

  it('ignores a malformed or negative override and keeps the default', () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = 'not-a-number';
    expect(resolveOverloadPauseCeilingMs('cli')).toBe(OVERLOAD_PAUSE_CEILING_MS);
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '-1';
    expect(resolveOverloadPauseCeilingMs('daemon')).toBe(0);
  });
});

describe('jitterBackoff / nextProbeDelayMs', () => {
  it('never shortens the documented backoff and adds at most 25%', () => {
    expect(jitterBackoff(20_000, () => 0)).toBe(20_000);
    expect(jitterBackoff(20_000, () => 0.999_999)).toBeLessThanOrEqual(25_000);
    expect(jitterBackoff(20_000, () => 0.5)).toBeGreaterThan(20_000);
  });

  // The thundering-herd fix: three subagents that hit the same 529 in the same
  // second must not wake in lockstep.
  it('spreads concurrent retriers apart', () => {
    const delays = new Set(Array.from({ length: 50 }, () => jitterBackoff(5_000)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('draws probe delays from the 60–120s band', () => {
    expect(nextProbeDelayMs(() => 0)).toBe(OVERLOAD_PROBE_MIN_MS);
    expect(nextProbeDelayMs(() => 0.999_999)).toBeLessThan(OVERLOAD_PROBE_MAX_MS);
    for (let i = 0; i < 20; i++) {
      const d = nextProbeDelayMs();
      expect(d).toBeGreaterThanOrEqual(OVERLOAD_PROBE_MIN_MS);
      expect(d).toBeLessThanOrEqual(OVERLOAD_PROBE_MAX_MS);
    }
  });
});
