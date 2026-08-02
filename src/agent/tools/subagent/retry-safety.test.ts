/**
 * Direct unit tests for the stream-cut replay authorization predicate.
 *
 * These exercise `isChildReplaySafe` as a pure function. The integration side
 * — that `child-config.ts` threads the real registry and the real named-agent
 * surfaces into it — is covered by `child-config.test.ts`; this file pins the
 * decision table itself so a change in the predicate cannot pass by only
 * updating an integration expectation.
 */

import { describe, it, expect } from 'vitest';
import { isChildReplaySafe, type NestedAgentSurface } from './retry-safety.js';

/** A resolver over a fixed map; anything unnamed resolves `undefined`. */
function resolverFor(leaves: Record<string, NestedAgentSurface>) {
  return (name: string): NestedAgentSurface | undefined => leaves[name];
}

const READ_ONLY_LEAF: NestedAgentSurface = {
  allowedTools: ['read_file', 'grep', 'glob'],
  bashReadOnly: false,
  nestedAgentTypes: undefined,
};

/** Mirrors the real `git-investigator`: read tools + mechanically gated bash. */
const GATED_BASH_LEAF: NestedAgentSurface = {
  allowedTools: ['bash', 'read_file', 'grep', 'glob'],
  bashReadOnly: true,
  nestedAgentTypes: undefined,
};

/** Mirrors the real `general-purpose`: inherit-all. */
const INHERIT_ALL_LEAF: NestedAgentSurface = {
  allowedTools: undefined,
  bashReadOnly: false,
  nestedAgentTypes: undefined,
};

describe('isChildReplaySafe', () => {
  describe('condition 1 — own tool surface', () => {
    it('is true for a pure-read surface', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'grep', 'config_get'],
          nestedAgentTypes: undefined,
        }),
      ).toBe(true);
    });

    it('is false for an unrestricted surface', () => {
      expect(
        isChildReplaySafe({ effectiveAllowedTools: undefined, nestedAgentTypes: undefined }),
      ).toBe(false);
    });

    it.each(['write_file', 'edit_file', 'bash', 'send_telegram', 'config_set', 'browser_act'])(
      'is false when the surface grants side-effecting tool %s',
      (tool) => {
        expect(
          isChildReplaySafe({
            effectiveAllowedTools: ['read_file', tool],
            nestedAgentTypes: undefined,
          }),
        ).toBe(false);
      },
    );

    it('is true for an empty surface', () => {
      expect(isChildReplaySafe({ effectiveAllowedTools: [], nestedAgentTypes: undefined })).toBe(
        true,
      );
    });
  });

  describe('condition 2 — nested dispatch must be scoped', () => {
    it('is false for an unscoped grant (bare Agent token ⇒ undefined)', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: undefined,
          resolveNestedAgent: resolverFor({ 'git-investigator': GATED_BASH_LEAF }),
        }),
      ).toBe(false);
    });

    it('is true for an explicit deny-all scope (Agent() ⇒ [])', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: [],
        }),
      ).toBe(true);
    });

    it('clears a deny-all scope even with no resolver wired', () => {
      expect(
        isChildReplaySafe({ effectiveAllowedTools: ['read_file', 'agent'], nestedAgentTypes: [] }),
      ).toBe(true);
    });
  });

  describe('condition 3 — scoped names are resolved, not merely counted', () => {
    it('is false for a scoped grant naming an inherit-all type', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['general-purpose'],
          resolveNestedAgent: resolverFor({ 'general-purpose': INHERIT_ALL_LEAF }),
        }),
      ).toBe(false);
    });

    it('is false for a scoped grant naming a write-capable type', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['writer'],
          resolveNestedAgent: resolverFor({
            writer: {
              allowedTools: ['read_file', 'write_file'],
              bashReadOnly: false,
              nestedAgentTypes: undefined,
            },
          }),
        }),
      ).toBe(false);
    });

    it('is false for a scoped grant naming an unresolvable type', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['no-such-agent'],
          resolveNestedAgent: resolverFor({}),
        }),
      ).toBe(false);
    });

    it('is false for a non-empty scope when no resolver is wired', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['git-investigator'],
        }),
      ).toBe(false);
    });

    it('is true for a scoped grant naming a pure-read leaf', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['reader'],
          resolveNestedAgent: resolverFor({ reader: READ_ONLY_LEAF }),
        }),
      ).toBe(true);
    });

    it('is false when ANY name in a multi-type scope fails', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['reader', 'general-purpose'],
          resolveNestedAgent: resolverFor({
            reader: READ_ONLY_LEAF,
            'general-purpose': INHERIT_ALL_LEAF,
          }),
        }),
      ).toBe(false);
    });
  });

  describe('the gated-bash leaf exception (accepted, bounded, depth ≥2 only)', () => {
    it('admits a leaf whose bash is mechanically read-only gated', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['git-investigator'],
          resolveNestedAgent: resolverFor({ 'git-investigator': GATED_BASH_LEAF }),
        }),
      ).toBe(true);
    });

    it('refuses the same leaf when its bash is UNGATED', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['git-investigator'],
          resolveNestedAgent: resolverFor({
            'git-investigator': { ...GATED_BASH_LEAF, bashReadOnly: false },
          }),
        }),
      ).toBe(false);
    });

    // Invariant: the exception is depth-≥2 ONLY. A child holding gated bash
    // itself is still refused, because at depth 1 the replay re-runs commands
    // whose read-only classification is best-effort and unproven.
    it('does NOT extend the exception to the child itself at depth 1', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'bash'],
          nestedAgentTypes: undefined,
        }),
      ).toBe(false);
    });
  });

  describe('onward chains are refused rather than recursed', () => {
    it('is false for a leaf that itself grants scoped nested dispatch', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['mid'],
          resolveNestedAgent: resolverFor({
            mid: {
              allowedTools: ['read_file', 'agent'],
              bashReadOnly: false,
              nestedAgentTypes: ['leaf'],
            },
          }),
        }),
      ).toBe(false);
    });

    it('is false for a leaf that grants UNSCOPED nested dispatch', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['mid'],
          resolveNestedAgent: resolverFor({
            mid: {
              allowedTools: ['read_file', 'agent'],
              bashReadOnly: false,
              nestedAgentTypes: undefined,
            },
          }),
        }),
      ).toBe(false);
    });

    // A mutually-scoped pair would infinitely recurse under a recursive gate;
    // refusing non-terminal leaves means no cycle guard is needed at all.
    it('terminates on a mutually-scoped cycle', () => {
      const leaves: Record<string, NestedAgentSurface> = {
        a: { allowedTools: ['read_file', 'agent'], bashReadOnly: false, nestedAgentTypes: ['b'] },
        b: { allowedTools: ['read_file', 'agent'], bashReadOnly: false, nestedAgentTypes: ['a'] },
      };
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['a'],
          resolveNestedAgent: resolverFor(leaves),
        }),
      ).toBe(false);
    });

    // A leaf holding the dispatch tool but scoped deny-all reaches nothing, so
    // it IS terminal and stays admissible — the refusal targets reach, not the
    // mere presence of the `agent` token.
    it('admits a leaf whose own dispatch scope is deny-all', () => {
      expect(
        isChildReplaySafe({
          effectiveAllowedTools: ['read_file', 'agent'],
          nestedAgentTypes: ['terminal'],
          resolveNestedAgent: resolverFor({
            terminal: {
              allowedTools: ['read_file', 'agent'],
              bashReadOnly: false,
              nestedAgentTypes: [],
            },
          }),
        }),
      ).toBe(true);
    });
  });
});
