/**
 * Unit tests for `resolve-fork-scope` — pinning the contract that
 * readRoots/writeRoots passed to a fork of an unconfined parent have NO EFFECT
 * (Invariant #2: never confine an unconfined child).
 *
 * Issue #3766: the schema described these fields as "no effect" but there were
 * no tests pinning the actual behaviour. This file adds that coverage.
 *
 * @module agent/subagent/resolve-fork-scope.test
 */

import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { resolveReadScope, composeWriteRoots } from './resolve-fork-scope.js';

// ── composeWriteRoots ──────────────────────────────────────────────────────

describe('composeWriteRoots', () => {
  it('returns undefined when callerWriteRoots is undefined (no-op)', () => {
    expect(composeWriteRoots(undefined, '/some/cwd')).toBeUndefined();
  });

  it('returns undefined when callerWriteRoots is empty (no-op)', () => {
    expect(composeWriteRoots([], '/some/cwd')).toBeUndefined();
  });

  it('composes caller roots with cwd when cwd is defined', () => {
    const result = composeWriteRoots(['/extra/root'], '/my/cwd');
    expect(result).toContain('/my/cwd');
    expect(result).toContain('/extra/root');
  });

  it('returns only the caller roots (no base) when effectiveChildCwd is undefined — unconfined-parent case', () => {
    // This pins the behaviour described in schema and issue #3766:
    // when the parent is unconfined (no cwd), composeWriteRoots produces
    // a roots-only array (base = []), but the child's resolveBase stays
    // undefined so the `resolveBase === undefined` fast-path in `_cwd-utils.ts`
    // fires BEFORE consulting writeRoots — making these roots have no effect.
    const result = composeWriteRoots(['/would/be/ignored'], undefined);
    expect(result).toEqual(['/would/be/ignored']);
  });

  it('deduplicates when cwd already appears in callerWriteRoots', () => {
    const result = composeWriteRoots(['/my/cwd', '/extra'], '/my/cwd');
    expect(result?.filter((r) => r === '/my/cwd').length).toBe(1);
  });
});

// ── resolveReadScope — unconfined parent ──────────────────────────────────

describe('resolveReadScope — unconfined parent (Invariant #2)', () => {
  /** A resolveMainRoot stub that always returns undefined (no worktree). */
  const noMainRoot = vi.fn().mockResolvedValue(undefined);

  it('returns undefined when parent is unconfined and no caller extraReadRoots supplied', async () => {
    // parentReadRoots=undefined + parentCwd=undefined → parentUnconfined=true
    // willBeConfined=false → extraReadRoots never composed → returns undefined
    const result = await resolveReadScope({
      parentReadRoots: undefined,
      parentCwd: undefined,
      effectiveChildCwd: undefined,
      callerReadRoots: undefined,
      callerExtraReadRoots: undefined,
      resolveMainRoot: noMainRoot,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when parent is unconfined + extraReadRoots supplied but no cwd — pins Invariant #2', async () => {
    // This is the precise scenario from issue #3766:
    // fork of unconfined parent, readRoots passed, no cwd.
    // willBeConfined = (inheritedReadRoots !== undefined || effectiveChildCwd !== undefined)
    //                = (undefined !== undefined || undefined !== undefined) = false
    // → extraReadRoots silently dropped, returns undefined (child stays unconfined).
    const result = await resolveReadScope({
      parentReadRoots: undefined,
      parentCwd: undefined,
      effectiveChildCwd: undefined,
      callerReadRoots: undefined,
      callerExtraReadRoots: ['/caller/extra'],
      resolveMainRoot: noMainRoot,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when caller pinned readRoots (inheritance suppressed)', async () => {
    // Invariant #1: callerReadRoots suppresses inheritance entirely.
    const result = await resolveReadScope({
      parentReadRoots: undefined,
      parentCwd: undefined,
      effectiveChildCwd: undefined,
      callerReadRoots: ['/pinned'],
      callerExtraReadRoots: undefined,
      resolveMainRoot: noMainRoot,
    });
    expect(result).toBeUndefined();
  });
});

// ── resolveReadScope — confined parent ────────────────────────────────────

describe('resolveReadScope — confined parent', () => {
  const noMainRoot = vi.fn().mockResolvedValue(undefined);

  it('composes extraReadRoots when parent is confined (has cwd)', async () => {
    const result = await resolveReadScope({
      parentReadRoots: undefined,
      parentCwd: '/parent/cwd',
      effectiveChildCwd: '/parent/cwd',
      callerReadRoots: undefined,
      callerExtraReadRoots: ['/extra/read'],
      resolveMainRoot: noMainRoot,
    });
    // Child will be confined (effectiveChildCwd is defined), so extras are composed.
    // Use path.resolve so the assertion holds on Windows (path.resolve('/extra/read')
    // → 'D:\extra\read' on win32, matching what resolveReadScope produces internally).
    expect(result).toContain(path.resolve('/extra/read'));
  });

  it('does not compose extraReadRoots when callerReadRoots pins (Invariant #1)', async () => {
    const result = await resolveReadScope({
      parentReadRoots: undefined,
      parentCwd: '/parent/cwd',
      effectiveChildCwd: '/parent/cwd',
      callerReadRoots: ['/pinned'],
      callerExtraReadRoots: ['/extra/read'],
      resolveMainRoot: noMainRoot,
    });
    // Pinned readRoots suppress all inheritance including extraReadRoots.
    expect(result).toBeUndefined();
  });
});
