/**
 * Tests for `buildFallbackHint` — pause-card fallback hint line.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock getConfiguredFallbackModel so tests run without real config I/O.
vi.mock('../../agent/session/fallback-model.js', () => ({
  getConfiguredFallbackModel: vi.fn(),
}));

import { buildFallbackHint } from './fallback-hint.js';
import { getConfiguredFallbackModel } from '../../agent/session/fallback-model.js';

const mockGetFallback = vi.mocked(getConfiguredFallbackModel);

beforeEach(() => { mockGetFallback.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('buildFallbackHint', () => {
  it('returns undefined when no fallback is configured', () => {
    mockGetFallback.mockReturnValue(undefined);
    expect(buildFallbackHint('opus')).toBeUndefined();
  });

  it('returns undefined when already on the fallback model', () => {
    mockGetFallback.mockReturnValue('sonnet');
    expect(buildFallbackHint('sonnet')).toBeUndefined();
  });

  it('returns a hint line when fallback differs from current model', () => {
    mockGetFallback.mockReturnValue('sonnet');
    const hint = buildFallbackHint('opus');
    expect(hint).not.toBeUndefined();
    expect(hint).toContain('sonnet');
    expect(hint).toContain('/model sonnet');
    expect(hint).toContain('/retry');
  });

  it('hint references /model <fallback> then /retry', () => {
    mockGetFallback.mockReturnValue('haiku');
    const hint = buildFallbackHint('opus');
    // Exact instruction order: /model first, then /retry
    const modelIdx = hint!.indexOf('/model haiku');
    const retryIdx = hint!.indexOf('/retry');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(retryIdx).toBeGreaterThan(modelIdx);
  });
});
