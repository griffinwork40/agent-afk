import { describe, it, expect } from 'vitest';
import {
  stripTrailingAnnotation,
  stripAnnotationLabelPlusSpace,
  REINFORCED_LABEL,
  WEAKENED_LABEL,
} from './spine-hook.annotations.js';

const BASE = 'Single main branch; enforced by check-*.sh scripts.';

/**
 * All prefixes of ` (<label> 2026-09-22)` classified into:
 *
 * - `positive`: fragments that stripTrailingAnnotation SHOULD strip.
 *   This includes ` (` + ≥2 label chars up to the full label, PLUS every
 *   prefix once the date has started (≥1 date digit). It excludes
 *   ` (<label> ` (label complete + trailing space, zero date digits) because
 *   with `DATE_TEMPLATE = /^\d{1,4}…/`, an empty date string does not match.
 *
 * - `negative`: fragments that must be LEFT INTACT.
 *   - n<4: fewer than 2 label chars present (below MIN_LABEL_CHARS)
 *   - exactly ` (<label> ` (full label + one space, no date yet)
 */
function allPrefixes(label: string): { positive: string[]; negative: string[] } {
  const full = ` (${label} 2026-09-22)`;
  // The prefix that has the label complete + trailing space but no date yet
  const labelPlusSpace = ` (${label} `;
  const positive: string[] = [];
  const negative: string[] = [];
  for (let n = 2; n <= full.length; n++) {
    const frag = full.slice(0, n);
    // label chars present = n - 2 (skip the leading " (")
    const labelChars = n - 2;
    if (labelChars < 2) {
      // Below MIN_LABEL_CHARS: must NOT be stripped
      negative.push(frag);
    } else if (frag === labelPlusSpace) {
      // Full label + space but no date digit yet: \d{1,4} requires ≥1 digit,
      // so this must NOT be stripped (the bug that DATE_TEMPLATE=\d{0,4} caused)
      negative.push(frag);
    } else {
      positive.push(frag);
    }
  }
  return { positive, negative };
}

describe('stripTrailingAnnotation (#2484)', () => {
  for (const label of [REINFORCED_LABEL, WEAKENED_LABEL]) {
    it(`strips every truncation point of " (${label} YYYY-MM-DD)" at or above MIN_LABEL_CHARS`, () => {
      const { positive } = allPrefixes(label);
      for (const frag of positive) {
        expect(stripTrailingAnnotation(BASE + frag, label), JSON.stringify(frag)).toBe(BASE);
      }
    });

    it(`does NOT strip prefixes below MIN_LABEL_CHARS or at exactly label + " " (no date) for "${label}"`, () => {
      const { negative } = allPrefixes(label);
      // Covers: " (" (n=2), " (<1 char>" (n=3), and " (<label> " (full label+space, zero date digits)
      // The last case is the bug that DATE_TEMPLATE=\d{0,4} caused — it matches the empty string.
      for (const frag of negative) {
        expect(stripTrailingAnnotation(BASE + frag, label), JSON.stringify(frag)).toBe(BASE + frag);
      }
    });
  }

  it('boundary: strips exactly at MIN_LABEL_CHARS=2 (two label chars) and not at one char', () => {
    // 2 chars: " (re" — meets the threshold → should be stripped
    expect(stripTrailingAnnotation(`${BASE} (re`, REINFORCED_LABEL)).toBe(BASE);
    expect(stripTrailingAnnotation(`${BASE} (pa`, WEAKENED_LABEL)).toBe(BASE);
    // 1 char: " (r" / " (p" — below threshold → must be preserved
    expect(stripTrailingAnnotation(`${BASE} (r`, REINFORCED_LABEL)).toBe(`${BASE} (r`);
    expect(stripTrailingAnnotation(`${BASE} (p`, WEAKENED_LABEL)).toBe(`${BASE} (p`);
  });

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

describe('stripAnnotationLabelPlusSpace (#2921)', () => {
  it('positive: strips the exact " (<label> " tail for each label', () => {
    // The " (<label> " fragment is the shape left after a stacked-annotation
    // stripping pass clears the date but not the open-paren + label + space.
    expect(stripAnnotationLabelPlusSpace(`${BASE} (reinforced `, REINFORCED_LABEL)).toBe(BASE);
    expect(stripAnnotationLabelPlusSpace(`${BASE} (partially weakened `, WEAKENED_LABEL)).toBe(BASE);
  });

  it('no-op: returns description unchanged when the tail does not match', () => {
    // No annotation at all
    expect(stripAnnotationLabelPlusSpace(BASE, REINFORCED_LABEL)).toBe(BASE);
    expect(stripAnnotationLabelPlusSpace(BASE, WEAKENED_LABEL)).toBe(BASE);
    // Full annotation with date — NOT the label+space shape
    expect(
      stripAnnotationLabelPlusSpace(`${BASE} (reinforced 2026-09-22)`, REINFORCED_LABEL),
    ).toBe(`${BASE} (reinforced 2026-09-22)`);
    // Truncated annotation that still has date digits — also not this shape
    expect(
      stripAnnotationLabelPlusSpace(`${BASE} (reinforced 2026`, REINFORCED_LABEL),
    ).toBe(`${BASE} (reinforced 2026`);
    // Label alone without the trailing space — not this exact shape
    expect(
      stripAnnotationLabelPlusSpace(`${BASE} (reinforced`, REINFORCED_LABEL),
    ).toBe(`${BASE} (reinforced`);
  });

  it('cross-label: does NOT strip the wrong label', () => {
    // A " (reinforced " tail must not be stripped when asked about WEAKENED_LABEL
    expect(
      stripAnnotationLabelPlusSpace(`${BASE} (reinforced `, WEAKENED_LABEL),
    ).toBe(`${BASE} (reinforced `);
    // A " (partially weakened " tail must not be stripped when asked about REINFORCED_LABEL
    expect(
      stripAnnotationLabelPlusSpace(`${BASE} (partially weakened `, REINFORCED_LABEL),
    ).toBe(`${BASE} (partially weakened `);
  });
});
