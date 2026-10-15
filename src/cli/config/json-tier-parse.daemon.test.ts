/**
 * Tests for `parseDaemonBlock` — verifying absent age keys stay `undefined`
 * so that `resolveSweepPolicy` can fall through to env/default layers (#3272).
 */

import { describe, it, expect } from 'vitest';
import { parseDaemonBlock } from './json-tier-parse.daemon.js';

describe('parseDaemonBlock', () => {
  it('preserves explicit age values when present', () => {
    const result = parseDaemonBlock({
      worktreePrune: { maxAgeDaysClean: 7, maxAgeDaysDirty: 21 },
    });
    expect(result.worktreePrune?.maxAgeDaysClean).toBe(7);
    expect(result.worktreePrune?.maxAgeDaysDirty).toBe(21);
  });

  it('omits age keys when absent from JSON so env fallback works (#3272)', () => {
    const result = parseDaemonBlock({
      worktreePrune: { enabled: true },
    });
    expect(result.worktreePrune).toBeDefined();
    expect(result.worktreePrune?.maxAgeDaysClean).toBeUndefined();
    expect(result.worktreePrune?.maxAgeDaysDirty).toBeUndefined();
  });

  it('omits age keys when worktreePrune has only cron and scope', () => {
    const result = parseDaemonBlock({
      worktreePrune: { cron: '0 3 * * *', scope: 'interactive' },
    });
    expect(result.worktreePrune?.cron).toBe('0 3 * * *');
    expect(result.worktreePrune?.scope).toBe('interactive');
    expect(result.worktreePrune?.maxAgeDaysClean).toBeUndefined();
    expect(result.worktreePrune?.maxAgeDaysDirty).toBeUndefined();
  });

  it('preserves one age key and omits the other', () => {
    const result = parseDaemonBlock({
      worktreePrune: { maxAgeDaysClean: 5 },
    });
    expect(result.worktreePrune?.maxAgeDaysClean).toBe(5);
    expect(result.worktreePrune?.maxAgeDaysDirty).toBeUndefined();
  });
});
