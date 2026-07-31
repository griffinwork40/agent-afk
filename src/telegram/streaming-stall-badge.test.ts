/**
 * Tests for the Telegram subagent stall badge.
 *
 * Contract that matters: the badge is SILENT on the healthy path (empty string,
 * so the caller stays a plain concatenation) and is an alarm rather than a
 * report when it does fire.
 */

import { describe, it, expect } from 'vitest';
import { ActivityTracker } from '../agent/progress/activity-tracker.js';
import {
  renderStallBadge,
  TELEGRAM_STALL_THRESHOLD_MS,
} from './streaming-stall-badge.js';

const T0 = 1_700_000_000_000;

function trackerWith(entries: ReadonlyArray<[string, number, string?]>): ActivityTracker {
  const t = new ActivityTracker();
  for (const [id, at, agentType] of entries) {
    t.note({ subagentId: id, at, ...(agentType ? { agentType } : {}) });
  }
  return t;
}

describe('renderStallBadge', () => {
  it('is empty when nothing is tracked', () => {
    expect(renderStallBadge(new ActivityTracker(), T0)).toBe('');
  });

  it('is empty when every child is fresh', () => {
    const t = trackerWith([['a', T0]]);
    expect(renderStallBadge(t, T0 + 1_000)).toBe('');
  });

  it('is empty for a settled child no matter how long ago it finished', () => {
    const t = new ActivityTracker();
    t.note({ subagentId: 'a', at: T0, settled: true });
    expect(renderStallBadge(t, T0 + 600_000)).toBe('');
  });

  it('names a single quiet child with its agent type and elapsed silence', () => {
    const t = trackerWith([['a', T0, 'research-agent']]);
    const badge = renderStallBadge(t, T0 + 90_000);
    expect(badge).toContain('1 sub-agent quiet');
    expect(badge).toContain('research-agent');
    expect(badge).toContain('1m 30s');
  });

  it('falls back to the subagent id when no agent type is known', () => {
    const t = trackerWith([['sub-7', T0]]);
    expect(renderStallBadge(t, T0 + 90_000)).toContain('sub-7');
  });

  it('pluralizes and caps the named children at two, counting the rest', () => {
    const t = trackerWith([
      ['a', T0, 'aa'],
      ['b', T0, 'bb'],
      ['c', T0, 'cc'],
      ['d', T0, 'dd'],
    ]);
    const badge = renderStallBadge(t, T0 + 120_000);
    expect(badge).toContain('4 sub-agents quiet');
    expect(badge).toContain('+2 more');
  });

  it('starts with a newline so it concatenates onto an existing footer', () => {
    const t = trackerWith([['a', T0]]);
    expect(renderStallBadge(t, T0 + 90_000).startsWith('\n')).toBe(true);
  });

  it('uses a higher default threshold than the REPL — a push is an interruption', () => {
    const t = trackerWith([['a', T0]]);
    // Quiet for 45s: past the REPL's 30s bar, still under Telegram's 60s bar.
    expect(renderStallBadge(t, T0 + 45_000)).toBe('');
    expect(renderStallBadge(t, T0 + TELEGRAM_STALL_THRESHOLD_MS + 1_000)).not.toBe('');
  });

  it('honors an explicit threshold override', () => {
    const t = trackerWith([['a', T0]]);
    expect(renderStallBadge(t, T0 + 10_000, 5_000)).toContain('quiet');
  });

  it('renders whole seconds under a minute', () => {
    const t = trackerWith([['a', T0]]);
    expect(renderStallBadge(t, T0 + 75_000, 30_000)).toContain('1m 15s');
    expect(renderStallBadge(t, T0 + 45_000, 30_000)).toContain('45s');
    expect(renderStallBadge(t, T0 + 120_000, 30_000)).toContain('2m');
  });
});
