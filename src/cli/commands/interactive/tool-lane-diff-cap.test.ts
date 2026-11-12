/**
 * Unit tests for tool-lane-diff-cap.ts — the per-session diff-cap state machine.
 *
 * Covers:
 *   - cycleDiffCap() cycle order: compact → expanded → full → compact
 *   - currentDiffCap() returns correct numeric value per state
 *   - resetDiffCap() returns state to compact from any position
 *   - getDiffCapState() reads without advancing
 *   - diffCapHint() returns distinct strings per state
 *   - currentDiffCap() respects AFK_DIFF_LINES env in compact state
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  cycleDiffCap,
  currentDiffCap,
  resetDiffCap,
  getDiffCapState,
  diffCapHint,
} from './tool-lane-diff-cap.js';

beforeEach(() => {
  resetDiffCap();
  vi.unstubAllEnvs();
});

describe('cycleDiffCap', () => {
  it('cycles compact → expanded → full → compact', () => {
    expect(getDiffCapState()).toBe('compact');
    expect(cycleDiffCap()).toBe('expanded');
    expect(cycleDiffCap()).toBe('full');
    expect(cycleDiffCap()).toBe('compact');
  });

  it('wraps back to compact after full', () => {
    cycleDiffCap(); // expanded
    cycleDiffCap(); // full
    cycleDiffCap(); // compact
    expect(getDiffCapState()).toBe('compact');
  });
});

describe('currentDiffCap', () => {
  it('returns 30 in compact state (default)', () => {
    expect(currentDiffCap()).toBe(30);
  });

  it('returns 50 in expanded state', () => {
    cycleDiffCap();
    expect(currentDiffCap()).toBe(50);
  });

  it('returns 0 in full state', () => {
    cycleDiffCap();
    cycleDiffCap();
    expect(currentDiffCap()).toBe(0);
  });

  it('respects AFK_DIFF_LINES env in compact state', () => {
    vi.stubEnv('AFK_DIFF_LINES', '75');
    expect(currentDiffCap()).toBe(75);
  });

  it('falls back to 30 for invalid AFK_DIFF_LINES in compact state', () => {
    vi.stubEnv('AFK_DIFF_LINES', 'abc');
    expect(currentDiffCap()).toBe(30);
  });

  it('falls back to 30 for decimal AFK_DIFF_LINES', () => {
    vi.stubEnv('AFK_DIFF_LINES', '1.5');
    expect(currentDiffCap()).toBe(30);
  });

  it('honours AFK_DIFF_LINES=0 (unlimited) in compact state', () => {
    vi.stubEnv('AFK_DIFF_LINES', '0');
    expect(currentDiffCap()).toBe(0);
  });

  it('ignores AFK_DIFF_LINES in expanded state', () => {
    vi.stubEnv('AFK_DIFF_LINES', '99');
    cycleDiffCap(); // compact → expanded
    expect(currentDiffCap()).toBe(50);
  });
});

describe('resetDiffCap', () => {
  it('returns state to compact from expanded', () => {
    cycleDiffCap();
    expect(getDiffCapState()).toBe('expanded');
    resetDiffCap();
    expect(getDiffCapState()).toBe('compact');
  });

  it('returns state to compact from full', () => {
    cycleDiffCap();
    cycleDiffCap();
    expect(getDiffCapState()).toBe('full');
    resetDiffCap();
    expect(getDiffCapState()).toBe('compact');
  });

  it('is idempotent when already compact', () => {
    resetDiffCap();
    resetDiffCap();
    expect(getDiffCapState()).toBe('compact');
  });
});

describe('diffCapHint', () => {
  it('names the selected state and future-only scope throughout the cycle', () => {
    for (const state of ['compact', 'expanded', 'full', 'compact']) {
      expect(diffCapHint()).toBe(
        `Future diff output: ${state} (Ctrl+X D to cycle); existing output unchanged.`,
      );
      cycleDiffCap();
    }
  });

  it('compact hint mentions Ctrl+X D', () => {
    expect(diffCapHint()).toContain('Ctrl+X D');
  });

  it('expanded hint mentions Ctrl+X D', () => {
    cycleDiffCap();
    expect(diffCapHint()).toContain('Ctrl+X D');
  });

  it('full hint mentions Ctrl+X D', () => {
    cycleDiffCap();
    cycleDiffCap();
    expect(diffCapHint()).toContain('Ctrl+X D');
  });
});
