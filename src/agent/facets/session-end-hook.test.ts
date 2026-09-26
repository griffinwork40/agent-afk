/**
 * Unit tests for the facet SessionEnd hook.
 *
 * Verifies the subagent guard (skips children), the no-sessionId guard,
 * derivation failures never propagate (best-effort contract), and that the
 * yield-probe is fired asynchronously for top-level sessions.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionEndContext } from '../hooks.js';
import { createFacetSessionEndHook } from './session-end-hook.js';

// Mock the store module so we can intercept getOrDeriveFacet calls
// without touching the real filesystem.
vi.mock('./store.js', () => ({
  getOrDeriveFacet: vi.fn(),
}));

// Mock yield-probe so we don't spawn real git/gh processes.
vi.mock('./yield-probe.js', () => ({
  writeFacetYield: vi.fn().mockResolvedValue(undefined),
}));

import { getOrDeriveFacet } from './store.js';
import { writeFacetYield } from './yield-probe.js';
const mockDerive = vi.mocked(getOrDeriveFacet);
const mockYield = vi.mocked(writeFacetYield);

function endCtx(over: Partial<SessionEndContext> = {}): SessionEndContext {
  return { event: 'SessionEnd', sessionId: 'sess-1', ...over };
}

describe('createFacetSessionEndHook', () => {
  it('derives a facet for a top-level session', () => {
    mockDerive.mockReturnValue({ session_id: 'top-level' } as ReturnType<typeof getOrDeriveFacet>);
    const hook = createFacetSessionEndHook();

    hook(endCtx({ sessionId: 'top-level' }));

    expect(mockDerive).toHaveBeenCalledTimes(1);
    expect(mockDerive).toHaveBeenCalledWith('top-level');
  });

  it('fires the yield probe after deriving the facet', () => {
    mockDerive.mockClear();
    mockYield.mockClear();
    mockDerive.mockReturnValue({ session_id: 'top-probe' } as ReturnType<typeof getOrDeriveFacet>);
    const hook = createFacetSessionEndHook();

    hook(endCtx({ sessionId: 'top-probe' }));

    // writeFacetYield is called (fire-and-forget) with sessionId, execFileAsync, and cwd
    // (undefined here because the test context has no cwd field).
    expect(mockYield).toHaveBeenCalledTimes(1);
    expect(mockYield).toHaveBeenCalledWith('top-probe', expect.any(Function), undefined);
  });

  it('threads cwd from context into writeFacetYield', () => {
    mockDerive.mockClear();
    mockYield.mockClear();
    mockDerive.mockReturnValue({ session_id: 'cwd-probe' } as ReturnType<typeof getOrDeriveFacet>);
    const hook = createFacetSessionEndHook();

    hook(endCtx({ sessionId: 'cwd-probe', cwd: '/some/repo' }));

    expect(mockYield).toHaveBeenCalledWith('cwd-probe', expect.any(Function), '/some/repo');
  });

  it('skips the yield probe when the facet cannot be derived', () => {
    mockDerive.mockClear();
    mockYield.mockClear();
    // No facet returned (undefined)
    mockDerive.mockReturnValue(undefined);
    const hook = createFacetSessionEndHook();

    hook(endCtx({ sessionId: 'no-facet' }));

    expect(mockYield).not.toHaveBeenCalled();
  });

  it('skips subagent sessions (parentSessionId set)', () => {
    mockDerive.mockClear();
    const hook = createFacetSessionEndHook();

    hook(endCtx({ sessionId: 'child-1', parentSessionId: 'parent-1' }));

    expect(mockDerive).not.toHaveBeenCalled();
  });

  it('skips when sessionId is absent', () => {
    mockDerive.mockClear();
    const hook = createFacetSessionEndHook();

    hook(endCtx({ sessionId: undefined }));

    expect(mockDerive).not.toHaveBeenCalled();
  });

  it('returns {} for non-SessionEnd events', () => {
    mockDerive.mockClear();
    const hook = createFacetSessionEndHook();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = hook({ event: 'SessionStart', sessionId: 'x' } as any);

    expect(result).toEqual({});
    expect(mockDerive).not.toHaveBeenCalled();
  });

  it('swallows derivation errors without propagating', () => {
    mockDerive.mockClear();
    mockDerive.mockImplementation(() => {
      throw new Error('corrupt session JSON');
    });
    const hook = createFacetSessionEndHook();

    // Must not throw
    expect(() => hook(endCtx({ sessionId: 'corrupt' }))).not.toThrow();
    expect(mockDerive).toHaveBeenCalledWith('corrupt');
  });
});
