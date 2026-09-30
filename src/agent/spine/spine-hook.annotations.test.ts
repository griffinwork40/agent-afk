import { describe, it, expect } from 'vitest';
import {
  stripTrailingAnnotation,
  stripAnyStatusAnnotation,
  REINFORCED_LABEL,
  WEAKENED_LABEL,
} from './spine-hook.annotations.js';

const BASE = 'Single main branch; enforced by check-*.sh scripts.';

/** Every prefix of ` (<label> 2026-09-22)` from ` (` + 2 label chars to the full annotation. */
function allPrefixes(label: string): string[] {
  const full = ` (${label} 2026-09-22)`;
  const out: string[] = [];
  for (let n = 2 + 2; n <= full.length; n++) out.push(full.slice(0, n));
  return out;
}

describe('stripTrailingAnnotation (#2484)', () => {
  for (const label of [REINFORCED_LABEL, WEAKENED_LABEL]) {
    it(`strips every truncation point of " (${label} YYYY-MM-DD)"`, () => {
      for (const frag of allPrefixes(label)) {
        expect(stripTrailingAnnotation(BASE + frag, label), JSON.stringify(frag)).toBe(BASE);
      }
    });
  }

  it('strips the exact fragments observed in goblin-portal SPINE.md', () => {
    expect(stripTrailingAnnotation(`${BASE} (reinf`, REINFORCED_LABEL)).toBe(BASE);
    expect(stripTrailingAnnotation(`${BASE} (partially weakened 2026-09-2`, WEAKENED_LABEL)).toBe(BASE);
  });

  it('leaves legitimate trailing parentheticals intact', () => {
    for (const s of [
      `${BASE} (r`,
      `${BASE} (see INV-002)`,
      `${BASE} (reinforcement pending)`,
      `${BASE} (reinforced by review)`,
      `${BASE} (partial rollout)`,
      `${BASE} (reinforced 2026-09-22) extra`,
      BASE,
    ]) {
      expect(stripTrailingAnnotation(s, REINFORCED_LABEL), s).toBe(s);
      expect(stripTrailingAnnotation(s, WEAKENED_LABEL), s).toBe(s);
    }
  });

  it('only strips the annotation for the label it was asked about', () => {
    const weakened = `${BASE} (partially weakened 2026-09-22)`;
    expect(stripTrailingAnnotation(weakened, REINFORCED_LABEL)).toBe(weakened);
  });
});

describe('stripAnyStatusAnnotation — chain collapse', () => {
  it('strips a single reinforced annotation', () => {
    expect(stripAnyStatusAnnotation(`${BASE} (reinforced 2026-09-22)`)).toBe(BASE);
  });

  it('strips a single partially-weakened annotation', () => {
    expect(stripAnyStatusAnnotation(`${BASE} (partially weakened 2026-09-22)`)).toBe(BASE);
  });

  it('collapses a two-annotation chain (weaken then reinforce)', () => {
    const chained = `${BASE} (partially weakened 2026-09-20) (reinforced 2026-09-22)`;
    expect(stripAnyStatusAnnotation(chained)).toBe(BASE);
  });

  it('collapses a three-annotation chain (existing disk corruption scenario)', () => {
    const chained =
      `${BASE} (partially weakened 2026-09-14) (reinforced 2026-09-20) (partially weakened 2026-09-22)`;
    expect(stripAnyStatusAnnotation(chained)).toBe(BASE);
  });

  it('collapses a chain with a truncated fragment at the tail', () => {
    // Simulates a chain where the last annotation was truncated before the closing paren
    const chained = `${BASE} (reinforced 2026-09-20) (partially weakened 2026-09-2`;
    expect(stripAnyStatusAnnotation(chained)).toBe(BASE);
  });

  it('leaves the base text unchanged when no annotation is present', () => {
    expect(stripAnyStatusAnnotation(BASE)).toBe(BASE);
  });

  it('leaves legitimate trailing parentheticals intact', () => {
    const s = `${BASE} (see INV-002)`;
    expect(stripAnyStatusAnnotation(s)).toBe(s);
  });
});
