/**
 * Tests for the synthesizeAndWriteEpisode barrel (index.ts):
 *   - daemon gate blocks daemon-sourced sessions
 *   - daemon gate is bypassed when options.force is true
 *   - substance gate still works as before
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EpisodeInput, EpisodeRecord } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<EpisodeInput> = {}): EpisodeInput {
  return {
    sessionId: 'test-session-123',
    firstUserMessage: 'Please refactor the auth module',
    markSequence: [],
    toolsUsed: ['read_file', 'edit_file'],
    toolErrors: [],
    lastAssistantMessage: 'Done! The auth module has been refactored.',
    ...overrides,
  };
}

function makeEpisode(sessionId = 'test-session-123'): EpisodeRecord {
  return {
    sessionId,
    goal: 'Refactor the auth module',
    approach: 'Read and edit',
    pivots: [],
    decisions: [],
    outcome: 'Done',
    openQuestions: [],
    filesKey: [],
    tags: ['refactor'],
    narrative: 'Refactored auth.',
    synthesizedAt: '2026-01-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Daemon gate
// ---------------------------------------------------------------------------

describe('synthesizeAndWriteEpisode — daemon gate', () => {
  it('returns null for daemon-sourced sessions', async () => {
    const mockExtract = vi.fn().mockReturnValue(makeInput({ source: 'daemon' }));
    const mockSynthesize = vi.fn();
    const mockWrite = vi.fn();

    vi.doMock('./extract.js', () => ({ extractEpisodeInput: mockExtract }));
    vi.doMock('./synthesize.js', () => ({ synthesizeEpisode: mockSynthesize }));
    vi.doMock('./writer.js', () => ({ writeEpisode: mockWrite }));

    const { synthesizeAndWriteEpisode } = await import('./index.js');
    const result = await synthesizeAndWriteEpisode('daemon-sess');

    expect(result).toBeNull();
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('bypasses daemon gate when options.force is true', async () => {
    const episode = makeEpisode('daemon-sess');
    const mockExtract = vi.fn().mockReturnValue(makeInput({ sessionId: 'daemon-sess', source: 'daemon' }));
    const mockSynthesize = vi.fn().mockResolvedValue(episode);
    const mockWrite = vi.fn().mockResolvedValue(undefined);

    vi.doMock('./extract.js', () => ({ extractEpisodeInput: mockExtract }));
    vi.doMock('./synthesize.js', () => ({ synthesizeEpisode: mockSynthesize }));
    vi.doMock('./writer.js', () => ({ writeEpisode: mockWrite }));

    const { synthesizeAndWriteEpisode } = await import('./index.js');
    const result = await synthesizeAndWriteEpisode('daemon-sess', { force: true });

    expect(result).toBe(episode);
    expect(mockSynthesize).toHaveBeenCalledOnce();
    expect(mockWrite).toHaveBeenCalledOnce();
  });

  it('does not block non-daemon sources', async () => {
    const episode = makeEpisode();
    const mockExtract = vi.fn().mockReturnValue(makeInput({ source: 'cli' }));
    const mockSynthesize = vi.fn().mockResolvedValue(episode);
    const mockWrite = vi.fn().mockResolvedValue(undefined);

    vi.doMock('./extract.js', () => ({ extractEpisodeInput: mockExtract }));
    vi.doMock('./synthesize.js', () => ({ synthesizeEpisode: mockSynthesize }));
    vi.doMock('./writer.js', () => ({ writeEpisode: mockWrite }));

    const { synthesizeAndWriteEpisode } = await import('./index.js');
    const result = await synthesizeAndWriteEpisode('test-session-123');

    expect(result).toBe(episode);
    expect(mockSynthesize).toHaveBeenCalledOnce();
  });

  it('does not block sessions with no source field', async () => {
    const episode = makeEpisode();
    const mockExtract = vi.fn().mockReturnValue(makeInput()); // no source
    const mockSynthesize = vi.fn().mockResolvedValue(episode);
    const mockWrite = vi.fn().mockResolvedValue(undefined);

    vi.doMock('./extract.js', () => ({ extractEpisodeInput: mockExtract }));
    vi.doMock('./synthesize.js', () => ({ synthesizeEpisode: mockSynthesize }));
    vi.doMock('./writer.js', () => ({ writeEpisode: mockWrite }));

    const { synthesizeAndWriteEpisode } = await import('./index.js');
    const result = await synthesizeAndWriteEpisode('test-session-123');

    expect(result).toBe(episode);
  });
});

// ---------------------------------------------------------------------------
// Substance gate (pre-existing, but confirm not broken)
// ---------------------------------------------------------------------------

describe('synthesizeAndWriteEpisode — substance gate', () => {
  it('returns null for sessions with no user content and no tools', async () => {
    const mockExtract = vi.fn().mockReturnValue(
      makeInput({ firstUserMessage: '', toolsUsed: [] }),
    );
    const mockSynthesize = vi.fn();
    const mockWrite = vi.fn();

    vi.doMock('./extract.js', () => ({ extractEpisodeInput: mockExtract }));
    vi.doMock('./synthesize.js', () => ({ synthesizeEpisode: mockSynthesize }));
    vi.doMock('./writer.js', () => ({ writeEpisode: mockWrite }));

    const { synthesizeAndWriteEpisode } = await import('./index.js');
    const result = await synthesizeAndWriteEpisode('empty-sess');

    expect(result).toBeNull();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });
});
