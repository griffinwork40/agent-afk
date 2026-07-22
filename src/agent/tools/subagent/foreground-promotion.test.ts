/**
 * Unit tests for the `withProvenanceHeader` gate — the pure decision of whether
 * a returned subagent result is stamped with its producing model.
 */
import { describe, it, expect } from 'vitest';
import { withProvenanceHeader } from './foreground-promotion.js';

describe('withProvenanceHeader', () => {
  it('prepends a provenance header when the child model differs from the parent', () => {
    expect(withProvenanceHeader('finding', 'sonnet', 'opus')).toBe(
      '[subagent result · model=sonnet (parent: opus)]\n\nfinding',
    );
  });

  it('returns content unchanged when the child model equals the parent', () => {
    expect(withProvenanceHeader('finding', 'sonnet', 'sonnet')).toBe('finding');
  });

  it('returns content unchanged when the child model is unknown', () => {
    expect(withProvenanceHeader('finding', undefined, 'opus')).toBe('finding');
  });

  it('returns content unchanged when the parent model is not wired', () => {
    expect(withProvenanceHeader('finding', 'sonnet', undefined)).toBe('finding');
  });

  it('preserves an incomplete-partial marker beneath the provenance header', () => {
    // Composes with annotateIfIncomplete output: the header wraps the already-
    // annotated body, so both signals survive.
    const annotated = '[⚠ PARTIAL RESULT — the subagent …]\n\nbody';
    expect(withProvenanceHeader(annotated, 'haiku', 'opus')).toBe(
      `[subagent result · model=haiku (parent: opus)]\n\n${annotated}`,
    );
  });
});
