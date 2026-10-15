/**
 * Regression guard for #2543: `pathIsWithin` must not touch the filesystem
 * when the case-folded strings cannot overlap.
 *
 * The glob walker calls it for every denylist root on every entry it visits;
 * probing first cost two synchronous statSync calls each time and made a
 * $HOME glob take minutes.
 *
 * Run with: pnpm test src/agent/tools/fs-case.probe-skip.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const statSpy = vi.hoisted(() => ({ calls: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: ((...args: Parameters<typeof actual.statSync>) => {
      statSpy.calls++;
      return actual.statSync(...args);
    }) as typeof actual.statSync,
  };
});

const { pathIsWithin, _resetFsCaseCacheForTests } = await import('./fs-case.js');

describe('pathIsWithin probe ordering (#2543)', () => {
  beforeEach(() => {
    _resetFsCaseCacheForTests();
    statSpy.calls = 0;
  });

  it('does not probe the filesystem for an unrelated path', () => {
    expect(pathIsWithin('/tmp/project/src/index.ts', '/tmp/somewhere/.ssh')).toBe(false);
    expect(statSpy.calls).toBe(0);
  });

  it('does not probe for a sibling that only shares a prefix', () => {
    expect(pathIsWithin('/tmp/u/.sshx/key', '/tmp/u/.ssh')).toBe(false);
    expect(statSpy.calls).toBe(0);
  });

  it('does not probe for an exact match', () => {
    expect(pathIsWithin('/tmp/u/.ssh/id', '/tmp/u/.ssh')).toBe(true);
    expect(statSpy.calls).toBe(0);
  });

  it('still probes when only a case-variant spelling overlaps', () => {
    pathIsWithin('/tmp/u/.SSH/id', '/tmp/u/.ssh');
    expect(statSpy.calls).toBeGreaterThan(0);
  });
});
