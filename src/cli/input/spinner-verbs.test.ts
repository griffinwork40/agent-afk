import { describe, expect, it } from 'vitest';
import { GOBLIN_SPINNER_VERBS, SPINNER_VERBS } from '../constants.js';
import { CATEGORY_HUMAN_VERB, TOOL_VERB_OVERRIDES } from '../tool-category.js';

const flavourVerbs = [...SPINNER_VERBS, ...GOBLIN_SPINNER_VERBS];

describe('spinner flavour vocabulary', () => {
  it('never overlaps with category or tool-specific work verbs', () => {
    const workVerbs = new Set([
      ...Object.values(CATEGORY_HUMAN_VERB),
      ...Object.values(TOOL_VERB_OVERRIDES),
    ].map(verb => verb.replace(/…$/, '')));
    expect(flavourVerbs.filter(verb => workVerbs.has(verb))).toEqual([]);
  });

  it('keeps every flavour verb within 13 characters', () => {
    // Invariant: renderSpinnerRow does not clip the verb to terminal width.
    expect(flavourVerbs.filter(verb => verb.length > 13)).toEqual([]);
  });

  it('keeps the noir and goblin pools disjoint', () => {
    const noirVerbs = new Set(SPINNER_VERBS);
    expect(GOBLIN_SPINNER_VERBS.filter(verb => noirVerbs.has(verb))).toEqual([]);
  });
});
