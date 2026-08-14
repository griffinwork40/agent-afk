/**
 * Unit tests for the facet SessionEnd hook.
 *
 * Verifies the subagent guard (skips children), the no-sessionId guard,
 * and that derivation failures never propagate (best-effort contract).
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionEndContext } from '../hooks.js';
import { createFacetSessionEndHook } from './session-end-hook.js';

// Mock the store module so we can intercept getOrDeriveFacet calls
// without touching the real filesystem.
vi.mock('./store.js', () => ({
  getOrDeriveFacet: vi.fn(),
}));

import { getOrDeriveFacet } from './store.js';
const mockDerive = vi.mocked(getOrDeriveFacet);

function endCtx(over: Partial<SessionEndContext> = {}): SessionEndContext {
  return { event: 'SessionEnd', sessionId: 'sess-1', ...over };
}

describe('createFacetSessionEndHook', () => {
  it('derives a facet for a top-level session', () => {
    const hook = createFacetSessionEndHook();

    hook(endCtx({ sessionId: 'top-level' }));

    expect(mockDerive).toHaveBeenCalledTimes(1);
    expect(mockDerive).toHaveBeenCalledWith('top-level');
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
