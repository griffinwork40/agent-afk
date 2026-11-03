/**
 * Tests for session-end-hook.ts gating logic:
 *   - returns {} for non-SessionEnd events
 *   - returns {} for subagent contexts (parentSessionId set)
 *   - returns {} when AFK_EPISODE_SYNTHESIS env flag is not '1'
 *   - returns {} when sessionId is missing
 *   - calls synthesizeAndWriteEpisode when all gates pass
 *   - calls patchFacetDecisions with synthesized decisions on happy path
 *   - calls patchFacetDecisions with [] when synthesis returns empty decisions (no-ops internally)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HookContext } from '../hooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionEndContext(overrides: Partial<{
  sessionId: string | undefined;
  parentSessionId: string | undefined;
}> = {}): HookContext {
  return {
    event: 'SessionEnd',
    sessionId: 'sess-abc',
    ...overrides,
  } as HookContext;
}

function nonSessionEndContext(): HookContext {
  return { event: 'SessionStart', sessionId: 'sess-abc' } as HookContext;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('AFK_EPISODE_SYNTHESIS', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEpisodeSessionEndHook — gating logic', () => {
  it('returns {} immediately for non-SessionEnd events', async () => {
    const mockSynthesize = vi.fn();
    vi.doMock('./index.js', () => ({ synthesizeAndWriteEpisode: mockSynthesize }));

    const { createEpisodeSessionEndHook } = await import('./session-end-hook.js');
    const hook = createEpisodeSessionEndHook();
    const result = await hook(nonSessionEndContext());

    expect(result).toEqual({});
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('returns {} for subagent contexts (parentSessionId set)', async () => {
    const mockSynthesize = vi.fn();
    vi.doMock('./index.js', () => ({ synthesizeAndWriteEpisode: mockSynthesize }));

    const { createEpisodeSessionEndHook } = await import('./session-end-hook.js');
    const hook = createEpisodeSessionEndHook();
    const result = await hook(sessionEndContext({ parentSessionId: 'parent-session-xyz' }));

    expect(result).toEqual({});
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('returns {} when AFK_EPISODE_SYNTHESIS is not set', async () => {
    vi.stubEnv('AFK_EPISODE_SYNTHESIS', '');
    const mockSynthesize = vi.fn();
    vi.doMock('./index.js', () => ({ synthesizeAndWriteEpisode: mockSynthesize }));

    const { createEpisodeSessionEndHook } = await import('./session-end-hook.js');
    const hook = createEpisodeSessionEndHook();
    const result = await hook(sessionEndContext());

    expect(result).toEqual({});
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('returns {} when AFK_EPISODE_SYNTHESIS is "0"', async () => {
    vi.stubEnv('AFK_EPISODE_SYNTHESIS', '0');
    const mockSynthesize = vi.fn();
    vi.doMock('./index.js', () => ({ synthesizeAndWriteEpisode: mockSynthesize }));

    const { createEpisodeSessionEndHook } = await import('./session-end-hook.js');
    const hook = createEpisodeSessionEndHook();
    const result = await hook(sessionEndContext());

    expect(result).toEqual({});
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('returns {} when sessionId is missing', async () => {
    const mockSynthesize = vi.fn();
    vi.doMock('./index.js', () => ({ synthesizeAndWriteEpisode: mockSynthesize }));

    const { createEpisodeSessionEndHook } = await import('./session-end-hook.js');
    const hook = createEpisodeSessionEndHook();
    const result = await hook(sessionEndContext({ sessionId: undefined }));

    expect(result).toEqual({});
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('calls synthesizeAndWriteEpisode when all gates pass', async () => {
    const mockSynthesize = vi.fn().mockResolvedValue({
      sessionId: 'sess-abc',
      goal: 'Test goal',
      approach: 'Test approach',
      pivots: [],
      decisions: ['Chose approach A', 'Avoided approach B'],
      outcome: 'Test outcome',
      openQuestions: [],
      filesKey: [],
      tags: [],
      narrative: 'Test narrative',
      synthesizedAt: '2026-01-01T00:00:00.000Z',
    });
    const mockPatch = vi.fn();
    vi.doMock('./index.js', () => ({ synthesizeAndWriteEpisode: mockSynthesize }));
    vi.doMock('../facets/yield-probe.js', () => ({ patchFacetDecisions: mockPatch }));

    const { createEpisodeSessionEndHook } = await import('./session-end-hook.js');
    const hook = createEpisodeSessionEndHook();
    const result = await hook(sessionEndContext());

    expect(mockSynthesize).toHaveBeenCalledOnce();
    expect(mockSynthesize).toHaveBeenCalledWith('sess-abc');
    // Backflow: patchFacetDecisions must fire with the synthesized decisions (#4569)
    expect(mockPatch).toHaveBeenCalledOnce();
    expect(mockPatch).toHaveBeenCalledWith('sess-abc', ['Chose approach A', 'Avoided approach B']);
    expect(result).toEqual({});
  });

  it('calls patchFacetDecisions with [] when synthesis returns empty decisions (no-ops internally)', async () => {
    const mockSynthesize = vi.fn().mockResolvedValue({
      sessionId: 'sess-abc',
      goal: 'Test goal',
      approach: 'Test approach',
      pivots: [],
      decisions: [],
      outcome: 'Test outcome',
      openQuestions: [],
      filesKey: [],
      tags: [],
      narrative: 'Test narrative',
      synthesizedAt: '2026-01-01T00:00:00.000Z',
    });
    const mockPatch = vi.fn();
    vi.doMock('./index.js', () => ({ synthesizeAndWriteEpisode: mockSynthesize }));
    vi.doMock('../facets/yield-probe.js', () => ({ patchFacetDecisions: mockPatch }));

    const { createEpisodeSessionEndHook } = await import('./session-end-hook.js');
    const hook = createEpisodeSessionEndHook();
    const result = await hook(sessionEndContext());

    expect(mockSynthesize).toHaveBeenCalledOnce();
    // Empty decisions array: patchFacetDecisions is NOT called (guard in hook)
    expect(mockPatch).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('swallows errors from synthesizeAndWriteEpisode and returns {}', async () => {
    const mockSynthesize = vi.fn().mockRejectedValue(new Error('synthesis failed'));
    vi.doMock('./index.js', () => ({ synthesizeAndWriteEpisode: mockSynthesize }));

    const { createEpisodeSessionEndHook } = await import('./session-end-hook.js');
    const hook = createEpisodeSessionEndHook();

    // Must not throw
    const result = await hook(sessionEndContext());

    expect(result).toEqual({});
    expect(mockSynthesize).toHaveBeenCalledOnce();
  });
});
