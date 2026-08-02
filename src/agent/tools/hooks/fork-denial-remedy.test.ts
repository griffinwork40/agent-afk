/**
 * Locks the fork-denial remedy wording contract.
 *
 * Invariant under test: the READ branch must name a re-dispatch with a concrete
 * `readRoots: [<path>]` literal, and must NOT suggest that a parent-side grant
 * made after dispatch can reach the running fork. A fork's roots are fixed at
 * dispatch (see `fork-denial-remedy.ts`), so grant-widening advice is
 * unactionable and drives the retry-until-timeout failure #544 fixed.
 */
import { describe, it, expect } from 'vitest';
import { buildForkDenialRemedy } from './fork-denial-remedy.js';

const P = '/tmp/scratch/data.json';

describe('buildForkDenialRemedy', () => {
  describe('read mode', () => {
    const remedy = buildForkDenialRemedy({ mode: 'read', resolvedPath: P });

    it('names the agent tool as the recovery vector', () => {
      expect(remedy).toContain('`agent` tool');
      expect(remedy).toContain('re-dispatch');
    });

    it('emits a copy-pasteable readRoots literal containing the resolved path', () => {
      expect(remedy).toContain(`readRoots: ["${P}"]`);
    });

    it('never mentions writeRoots (asserted by path-approval-hook.test.ts too)', () => {
      expect(remedy).not.toContain('writeRoots');
    });

    it('states that a post-dispatch grant cannot reach the fork', () => {
      // Guards against reintroducing "ask the operator to /allow-dir" as an
      // in-flight remedy: grants are snapshot at fork, so that advice is wrong.
      expect(remedy).toMatch(/fixed at dispatch/);
      expect(remedy).not.toContain('/allow-dir');
    });

    it('tells the fork to report the requirement upward', () => {
      expect(remedy).toContain('Return this exact path requirement to your parent.');
    });
  });

  describe('write mode', () => {
    const remedy = buildForkDenialRemedy({ mode: 'write', resolvedPath: P });

    it('keeps the pre-existing writeRoots remedy shape', () => {
      expect(remedy).toContain('`agent` tool');
      expect(remedy).toContain(`writeRoots: ["${P}"]`);
      expect(remedy).toContain('worktree isolation');
      expect(remedy).toContain('Return this exact path requirement to your parent.');
    });

    it('does not offer readRoots for a write denial', () => {
      expect(remedy).not.toContain('readRoots');
    });
  });

  it('JSON-quotes the path so a space-bearing path stays copy-pasteable', () => {
    const spaced = '/tmp/my scratch/a.txt';
    expect(buildForkDenialRemedy({ mode: 'read', resolvedPath: spaced })).toContain(
      `readRoots: ["${spaced}"]`,
    );
  });
});
