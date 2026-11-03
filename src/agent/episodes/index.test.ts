/**
 * Tests for the synthesizeAndWriteEpisode barrel (index.ts).
 *
 * The new implementation delegates to buildEpisodeFromFacet (facet-bridge)
 * and writeEpisode (writer). No LLM call, no extract/synthesize pipeline.
 *
 * Covered:
 *   - happy path: builds from facet and writes
 *   - returns null when facet yields no substance (empty goal + outcome)
 *   - does not call writeEpisode when returning null
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EpisodeRecord } from './types.js';

function makeEpisode(overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    sessionId: 'test-session-123',
    goal: 'Refactor the auth module',
    approach: 'Read and edit files',
    pivots: [],
    decisions: [],
    outcome: 'Done',
    openQuestions: [],
    filesKey: [],
    tags: ['refactor'],
    narrative: 'Refactored auth.',
    synthesizedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('synthesizeAndWriteEpisode — happy path', () => {
  it('builds from facet and writes the episode', async () => {
    const episode = makeEpisode();
    const mockBuild = vi.fn().mockReturnValue(episode);
    const mockWrite = vi.fn().mockResolvedValue(undefined);

    vi.doMock('./facet-bridge.js', () => ({ buildEpisodeFromFacet: mockBuild }));
    vi.doMock('./writer.js', () => ({ writeEpisode: mockWrite, formatEpisodeContent: vi.fn(), sanitizeNarrative: vi.fn() }));

    const { synthesizeAndWriteEpisode } = await import('./index.js');
    const result = await synthesizeAndWriteEpisode('test-session-123');

    expect(mockBuild).toHaveBeenCalledWith('test-session-123');
    expect(mockWrite).toHaveBeenCalledWith(episode);
    expect(result).toBe(episode);
  });
});

// ---------------------------------------------------------------------------
// Null / substance gate
// ---------------------------------------------------------------------------

describe('synthesizeAndWriteEpisode — null gate', () => {
  it('returns null when buildEpisodeFromFacet returns null', async () => {
    const mockBuild = vi.fn().mockReturnValue(null);
    const mockWrite = vi.fn();

    vi.doMock('./facet-bridge.js', () => ({ buildEpisodeFromFacet: mockBuild }));
    vi.doMock('./writer.js', () => ({ writeEpisode: mockWrite, formatEpisodeContent: vi.fn(), sanitizeNarrative: vi.fn() }));

    const { synthesizeAndWriteEpisode } = await import('./index.js');
    const result = await synthesizeAndWriteEpisode('empty-sess');

    expect(result).toBeNull();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns null when episode has empty goal and outcome', async () => {
    const episode = makeEpisode({ goal: '', outcome: '' });
    const mockBuild = vi.fn().mockReturnValue(episode);
    const mockWrite = vi.fn();

    vi.doMock('./facet-bridge.js', () => ({ buildEpisodeFromFacet: mockBuild }));
    vi.doMock('./writer.js', () => ({ writeEpisode: mockWrite, formatEpisodeContent: vi.fn(), sanitizeNarrative: vi.fn() }));

    const { synthesizeAndWriteEpisode } = await import('./index.js');
    const result = await synthesizeAndWriteEpisode('thin-sess');

    expect(result).toBeNull();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
