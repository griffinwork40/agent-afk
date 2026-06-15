/**
 * Tests for the path containment helpers used by all filesystem handlers
 * AND the path-approval PreToolUse hook.
 *
 * The two functions MUST agree on what "contained" means: `resolveAndContain`
 * throws when out-of-bounds, `wouldBeRestricted` returns `restricted: true`
 * on the SAME inputs. Drift would mean the hook prompts for paths the
 * handler then accepts (over-prompting) or skips paths the handler then
 * rejects (silent containment failure).
 */

import { describe, expect, it } from 'vitest';
import { resolveAndContain, wouldBeRestricted } from './_cwd-utils.js';
import type { ToolHandlerContext } from '../types.js';

const BASE = '/tmp/repo';
const OUTSIDE = '/etc/passwd';
const INSIDE = '/tmp/repo/src/foo.ts';

function ctx(overrides: Partial<ToolHandlerContext> = {}): ToolHandlerContext {
  return {
    cwd: BASE,
    resolveBase: BASE,
    readRoots: [BASE],
    writeRoots: [BASE],
    ...overrides,
  };
}

describe('resolveAndContain', () => {
  it('returns the absolute path for inputs inside the resolveBase', () => {
    expect(resolveAndContain(INSIDE, ctx())).toBe(INSIDE);
    expect(resolveAndContain('src/foo.ts', ctx())).toBe(INSIDE);
  });

  it('throws when path falls outside every allowed root', () => {
    expect(() => resolveAndContain(OUTSIDE, ctx())).toThrow(/outside the allowed/);
  });

  it('falls through to abs (no enforcement) when no resolveBase set', () => {
    expect(
      resolveAndContain(OUTSIDE, {
        cwd: undefined,
        resolveBase: undefined,
        readRoots: undefined,
        writeRoots: undefined,
      } as ToolHandlerContext),
    ).toBe(OUTSIDE);
  });

  it('accepts paths inside an extra granted root', () => {
    const extra = '/tmp/other';
    expect(
      resolveAndContain('/tmp/other/secrets.json', ctx({ readRoots: [BASE, extra] })),
    ).toBe('/tmp/other/secrets.json');
  });

  it('throws on writes to a read-only path', () => {
    expect(() =>
      resolveAndContain('/tmp/other/x.txt', ctx({ readRoots: [BASE, '/tmp/other'] }), 'write'),
    ).toThrow(/outside the allowed write roots/);
  });
});

describe('wouldBeRestricted', () => {
  it('agrees with resolveAndContain for inside paths (restricted=false)', () => {
    const verdict = wouldBeRestricted(INSIDE, ctx());
    expect(verdict.restricted).toBe(false);
    expect(verdict.resolved).toBe(INSIDE);
  });

  it('agrees with resolveAndContain for outside paths (restricted=true)', () => {
    const verdict = wouldBeRestricted(OUTSIDE, ctx());
    expect(verdict.restricted).toBe(true);
    expect(verdict.resolved).toBe(OUTSIDE);
    expect(verdict.roots).toContain(BASE);
  });

  it('returns restricted=false when no resolveBase (enforcement disabled)', () => {
    const verdict = wouldBeRestricted(OUTSIDE, {
      cwd: undefined,
      resolveBase: undefined,
      readRoots: undefined,
      writeRoots: undefined,
    } as ToolHandlerContext);
    expect(verdict.restricted).toBe(false);
  });

  it('distinguishes read vs write containment', () => {
    const c = ctx({ readRoots: [BASE, '/tmp/extra'], writeRoots: [BASE] });
    expect(wouldBeRestricted('/tmp/extra/x.txt', c, 'read').restricted).toBe(false);
    expect(wouldBeRestricted('/tmp/extra/x.txt', c, 'write').restricted).toBe(true);
  });

  it('resolves relative paths against resolveBase', () => {
    const verdict = wouldBeRestricted('src/foo.ts', ctx());
    expect(verdict.restricted).toBe(false);
    expect(verdict.resolved).toBe(INSIDE);
  });

  it('does not throw when restricted (key contract: returns instead of throws)', () => {
    expect(() => wouldBeRestricted(OUTSIDE, ctx())).not.toThrow();
  });
});
