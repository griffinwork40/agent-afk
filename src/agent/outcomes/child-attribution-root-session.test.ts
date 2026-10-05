/**
 * Tests for the rootSessionId attribution chain introduced in #2442.
 *
 * Verifies two invariants:
 *
 *   1. Direct-child regression: a depth-1 child (parentSessionId set,
 *      rootSessionId absent) credits artifacts to parentSessionId.
 *
 *   2. Depth-2 (grandchild) attribution: when rootSessionId is set and differs
 *      from parentSessionId, artifacts are credited to rootSessionId (the depth-0
 *      root) — not to the intermediate depth-1 parent.
 *
 * We spy on appendArtifacts (the call site that receives the resolved session id)
 * rather than hitting the real filesystem store, so the test is self-contained
 * and works without an outcomesDir override.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock appendArtifacts before importing child-attribution
// ---------------------------------------------------------------------------

const appendArtifactsSpy = vi.fn();

vi.mock('./store.js', () => ({
  appendArtifacts: appendArtifactsSpy,
}));

// Import after the mock is wired
const { createChildAttributionHook } = await import('./child-attribution.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runHook(context: Record<string, unknown>) {
  const hook = createChildAttributionHook();
  return hook(context as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createChildAttributionHook — rootSessionId chain (#2442)', () => {
  beforeEach(() => {
    appendArtifactsSpy.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Regression: depth-1 children (no rootSessionId) must still credit
   * artifacts to parentSessionId, exactly as before #2442.
   */
  it('direct-child (depth-1): credits commit to parentSessionId when rootSessionId absent', async () => {
    runHook({
      event: 'PostToolUse',
      toolName: 'bash',
      sessionId: 'child-depth-1',
      parentSessionId: 'root-depth-0',
      // rootSessionId intentionally absent — depth-1 case
      output: '[main abc1111] feat: direct-child commit',
    });

    // Drain the fire-and-forget microtask (Promise.resolve().then(...))
    await vi.runAllTimersAsync();

    expect(appendArtifactsSpy).toHaveBeenCalledOnce();
    expect(appendArtifactsSpy.mock.calls[0][0]).toBe('root-depth-0');
    const artifacts = appendArtifactsSpy.mock.calls[0][1];
    expect(artifacts.commits).toContain('abc1111');
  });

  /**
   * Core fix: a depth-2 grandchild carries rootSessionId = depth-0 root's id
   * and parentSessionId = depth-1 intermediate id. Artifacts must be credited
   * to rootSessionId, not to parentSessionId (the intermediate never has a
   * sidecar and would silently drop the attribution otherwise).
   */
  it('depth-2 grandchild: credits commit to rootSessionId, not parentSessionId', async () => {
    runHook({
      event: 'PostToolUse',
      toolName: 'bash',
      sessionId: 'grandchild-depth-2',
      parentSessionId: 'intermediate-depth-1',   // depth-1 intermediate
      rootSessionId: 'root-depth-0',             // depth-0 root — must receive credit
      output: '[main bbb2222] fix: grandchild commit',
    });

    await vi.runAllTimersAsync();

    expect(appendArtifactsSpy).toHaveBeenCalledOnce();
    // Must credit to the ROOT, not the intermediate
    expect(appendArtifactsSpy.mock.calls[0][0]).toBe('root-depth-0');
    expect(appendArtifactsSpy.mock.calls[0][0]).not.toBe('intermediate-depth-1');
    const artifacts = appendArtifactsSpy.mock.calls[0][1];
    expect(artifacts.commits).toContain('bbb2222');
  });

  /**
   * PR URL from a depth-2 grandchild is credited to rootSessionId.
   */
  it('depth-2 grandchild: credits PR URL to rootSessionId', async () => {
    runHook({
      event: 'PostToolUse',
      toolName: 'bash',
      sessionId: 'grandchild-pr',
      parentSessionId: 'intermediate-pr',
      rootSessionId: 'root-pr-depth-0',
      input: { command: 'gh pr create --title "fix: something" --body ""' },
      output: 'https://github.com/org/repo/pull/99',
    });

    await vi.runAllTimersAsync();

    expect(appendArtifactsSpy).toHaveBeenCalledOnce();
    expect(appendArtifactsSpy.mock.calls[0][0]).toBe('root-pr-depth-0');
    const artifacts = appendArtifactsSpy.mock.calls[0][1];
    expect(artifacts.prs).toContain('https://github.com/org/repo/pull/99');
  });

  /**
   * When rootSessionId === parentSessionId (depth-1 child that explicitly sets
   * rootSessionId to match its parent), the attribution still lands correctly.
   */
  it('depth-1 child with explicit rootSessionId matching parent: credits to root', async () => {
    runHook({
      event: 'PostToolUse',
      toolName: 'bash',
      sessionId: 'child-explicit-root',
      parentSessionId: 'same-root',
      rootSessionId: 'same-root',     // same as parent — degenerate depth-1 case
      output: '[main ccc3333] chore: explicit-root commit',
    });

    await vi.runAllTimersAsync();

    expect(appendArtifactsSpy).toHaveBeenCalledOnce();
    expect(appendArtifactsSpy.mock.calls[0][0]).toBe('same-root');
    const artifacts = appendArtifactsSpy.mock.calls[0][1];
    expect(artifacts.commits).toContain('ccc3333');
  });

  /**
   * Without parentSessionId the hook must return {} immediately (guard clause).
   */
  it('returns {} and does not call appendArtifacts when parentSessionId absent', async () => {
    const result = runHook({
      event: 'PostToolUse',
      toolName: 'bash',
      sessionId: 'root-only',
      output: '[main ddd4444] feat: top-level commit',
    });

    await vi.runAllTimersAsync();

    expect(result).toEqual({});
    expect(appendArtifactsSpy).not.toHaveBeenCalled();
  });
});
