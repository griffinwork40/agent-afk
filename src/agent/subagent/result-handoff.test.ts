/**
 * Tests for SubagentHandoff structured partial handoff parsing.
 *
 * Covers:
 *  - cap vs. completion (annotateIfIncomplete / parseHandoff)
 *  - malformed handoff (safely treated as incomplete)
 *  - missing handoff (safely absent)
 *  - valid handoff with all fields
 *  - valid handoff with partial fields
 *  - no external effect replay guarantee (advisory-only framing)
 *
 * @module agent/subagent/result-handoff.test
 */

import { describe, it, expect } from 'vitest';
import { parseHandoff } from './result.js';
import type { SubagentHandoff } from './result.js';

const FULL_HANDOFF: SubagentHandoff = {
  completedWork: 'Wrote auth module, passing tests',
  remainingWork: 'Integrate auth with API routes, update docs',
  externalEffectsApplied: ['git commit -m "Add auth module"', 'write_file src/auth.ts'],
  workspaceContext: {
    cwd: '/projects/myapp',
    gitBranch: 'feature/auth',
    headSha: 'abc123',
    dirtyCount: 2,
  },
  roundsConsumed: 47,
};

function makeHandoffComment(h: Record<string, unknown>): string {
  return `Some text\n<!-- HANDOFF: ${JSON.stringify(h)} -->\nMore text`;
}

describe('parseHandoff', () => {
  describe('missing handoff', () => {
    it('returns undefined when no handoff block is present', () => {
      expect(parseHandoff('no handoff here')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(parseHandoff('')).toBeUndefined();
    });
  });

  describe('malformed handoff (safely incomplete)', () => {
    it('returns undefined for invalid JSON', () => {
      expect(parseHandoff('<!-- HANDOFF: {invalid json} -->')).toBeUndefined();
    });

    it('returns undefined for a JSON array (wrong shape)', () => {
      expect(parseHandoff('<!-- HANDOFF: [1,2,3] -->')).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(parseHandoff('<!-- HANDOFF: null -->')).toBeUndefined();
    });

    it('returns undefined for an empty object (no recognizable fields)', () => {
      expect(parseHandoff('<!-- HANDOFF: {} -->')).toBeUndefined();
    });

    it('returns undefined for an object with only unknown fields', () => {
      expect(parseHandoff('<!-- HANDOFF: {"foo":"bar","baz":42} -->')).toBeUndefined();
    });
  });

  describe('valid handoff with all fields', () => {
    it('parses all fields correctly', () => {
      const content = makeHandoffComment(FULL_HANDOFF as Record<string, unknown>);
      const h = parseHandoff(content);
      expect(h).toBeDefined();
      expect(h!.completedWork).toBe('Wrote auth module, passing tests');
      expect(h!.remainingWork).toBe('Integrate auth with API routes, update docs');
      expect(h!.externalEffectsApplied).toEqual([
        'git commit -m "Add auth module"',
        'write_file src/auth.ts',
      ]);
      expect(h!.workspaceContext?.cwd).toBe('/projects/myapp');
      expect(h!.workspaceContext?.gitBranch).toBe('feature/auth');
      expect(h!.workspaceContext?.headSha).toBe('abc123');
      expect(h!.workspaceContext?.dirtyCount).toBe(2);
      expect(h!.roundsConsumed).toBe(47);
    });
  });

  describe('valid handoff with partial fields', () => {
    it('parses completedWork only', () => {
      const h = parseHandoff(makeHandoffComment({ completedWork: 'Done step 1' }));
      expect(h?.completedWork).toBe('Done step 1');
      expect(h?.remainingWork).toBeUndefined();
    });

    it('parses remainingWork only', () => {
      const h = parseHandoff(makeHandoffComment({ remainingWork: 'Step 2 and 3 pending' }));
      expect(h?.remainingWork).toBe('Step 2 and 3 pending');
      expect(h?.completedWork).toBeUndefined();
    });

    it('ignores non-string externalEffectsApplied elements', () => {
      const h = parseHandoff(
        makeHandoffComment({
          completedWork: 'test',
          externalEffectsApplied: ['valid', 42, null],
        }),
      );
      // Array contains non-strings — fails the every() check, field omitted
      expect(h?.externalEffectsApplied).toBeUndefined();
      // But completedWork should still parse
      expect(h?.completedWork).toBe('test');
    });

    it('ignores non-string/non-number workspaceContext fields', () => {
      const h = parseHandoff(
        makeHandoffComment({
          remainingWork: 'test',
          workspaceContext: { cwd: '/valid', dirtyCount: 'not-a-number' },
        }),
      );
      expect(h?.workspaceContext?.cwd).toBe('/valid');
      expect(h?.workspaceContext?.dirtyCount).toBeUndefined();
    });
  });

  describe('advisory-only framing (external effects)', () => {
    it('does not assert completion from externalEffectsApplied presence', () => {
      // The field is advisory: presence does NOT mean work is done, absence
      // does NOT mean no effects occurred. Tests that parse correctly but callers
      // must not treat as authoritative.
      const h = parseHandoff(
        makeHandoffComment({ externalEffectsApplied: ['write_file src/foo.ts'] }),
      );
      expect(h?.externalEffectsApplied).toEqual(['write_file src/foo.ts']);
      // No 'completed' or 'done' signal inferred from effects alone.
    });
  });

  describe('handoff block surrounded by content', () => {
    it('parses when block is embedded in a larger message', () => {
      const content = [
        '# Summary',
        'I completed step 1 and started step 2.',
        `<!-- HANDOFF: ${JSON.stringify({ completedWork: 'Step 1', remainingWork: 'Step 2', roundsConsumed: 30 })} -->`,
        'More text after.',
      ].join('\n');
      const h = parseHandoff(content);
      expect(h?.completedWork).toBe('Step 1');
      expect(h?.remainingWork).toBe('Step 2');
      expect(h?.roundsConsumed).toBe(30);
    });
  });
});
