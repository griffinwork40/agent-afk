/**
 * Tests for episode synthesize.ts:
 *   - parseLLMResponse (valid JSON, malformed, markdown-fenced, empty string)
 *   - deterministicFallback
 *   - synthesizeEpisode when no credential (returns fallback)
 *   - synthesizeEpisode with a mocked LLM call
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EpisodeInput } from './types.js';

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

const validLLMJson = JSON.stringify({
  goal: 'Refactor the auth module',
  approach: 'Read existing code then apply minimal changes',
  pivots: [],
  decisions: ['Use DI', 'Keep backward compat'],
  outcome: 'Auth module refactored',
  openQuestions: [],
  filesKey: ['src/auth.ts'],
  tags: ['refactor', 'auth'],
  narrative: 'User wanted auth refactored. Agent applied changes. Success.',
});

// ---------------------------------------------------------------------------
// Module-level mock setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseLLMResponse — tested indirectly via synthesizeEpisode with mocked LLM
// ---------------------------------------------------------------------------

describe('parseLLMResponse (via synthesizeEpisode)', () => {
  it('parses valid JSON into an EpisodeRecord', async () => {
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => 'fake-token',
    }));
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: async () => validLLMJson,
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const result = await synthesizeEpisode(makeInput());

    expect(result.goal).toBe('Refactor the auth module');
    expect(result.approach).toBe('Read existing code then apply minimal changes');
    expect(result.tags).toContain('auth');
    expect(result.filesKey).toContain('src/auth.ts');
    expect(result.synthesizedAt).toBeTruthy();
  });

  it('strips markdown fences and parses fenced JSON', async () => {
    const fenced = '```json\n' + validLLMJson + '\n```';
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => 'fake-token',
    }));
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: async () => fenced,
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const result = await synthesizeEpisode(makeInput());

    expect(result.goal).toBe('Refactor the auth module');
  });

  it('falls back to deterministic record on malformed JSON', async () => {
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => 'fake-token',
    }));
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: async () => 'not valid json at all {{{',
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const input = makeInput();
    const result = await synthesizeEpisode(input);

    // Falls back: goal is sliced from firstUserMessage
    expect(result.goal).toContain('refactor');
    expect(result.sessionId).toBe('test-session-123');
  });

  it('falls back to deterministic record on empty string response', async () => {
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => 'fake-token',
    }));
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: async () => '',
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const input = makeInput();
    const result = await synthesizeEpisode(input);

    expect(result.sessionId).toBe('test-session-123');
    expect(result.goal).toBeTruthy(); // deterministic fallback fills in a goal
  });

  it('falls back when parsed JSON has no goal field', async () => {
    const noGoal = JSON.stringify({ approach: 'something', outcome: 'done' });
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => 'fake-token',
    }));
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: async () => noGoal,
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const result = await synthesizeEpisode(makeInput());

    // parseLLMResponse returns a record but goal is '', so synthesizeEpisode
    // falls back to deterministicFallback
    expect(result.goal).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// deterministicFallback (no credential path)
// ---------------------------------------------------------------------------

describe('synthesizeEpisode — no credential', () => {
  it('returns a deterministic EpisodeRecord without calling the LLM', async () => {
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => null,
    }));
    const mockCompletion = vi.fn();
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: mockCompletion,
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const input = makeInput();
    const result = await synthesizeEpisode(input);

    expect(mockCompletion).not.toHaveBeenCalled();
    expect(result.sessionId).toBe('test-session-123');
    expect(result.goal).toContain('refactor'); // sliced from firstUserMessage (lowercased match)
    expect(result.approach).toContain('read_file'); // tool names
    expect(result.synthesizedAt).toBeTruthy();
  });

  it('uses facetSummary as outcome when available', async () => {
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => null,
    }));
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: vi.fn(),
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const input = makeInput({ facetSummary: 'outcome: fully_achieved, cost: $0.0042' });
    const result = await synthesizeEpisode(input);

    expect(result.outcome).toContain('fully_achieved');
  });

  it('marks conversational session in approach when no tools used', async () => {
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => null,
    }));
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: vi.fn(),
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const input = makeInput({ toolsUsed: [] });
    const result = await synthesizeEpisode(input);

    expect(result.approach).toBe('Conversational session');
  });

  it('extracts rewind/clear marks into pivots', async () => {
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => null,
    }));
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: vi.fn(),
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const input = makeInput({ markSequence: ['compact', 'rewind', 'clear', 'resume'] });
    const result = await synthesizeEpisode(input);

    expect(result.pivots).toContain('rewind');
    expect(result.pivots).toContain('clear');
    expect(result.pivots).not.toContain('compact');
    expect(result.pivots).not.toContain('resume');
  });

  it('falls back gracefully when LLM call throws', async () => {
    vi.doMock('../../agent/auth/credential-resolver.js', () => ({
      loadAnthropicCredential: () => 'fake-token',
    }));
    vi.doMock('../../agent/providers/whatif-api.js', () => ({
      oneShotCompletion: async () => { throw new Error('network error'); },
    }));

    const { synthesizeEpisode } = await import('./synthesize.js');
    const input = makeInput();
    const result = await synthesizeEpisode(input);

    // Must not throw; returns deterministic fallback
    expect(result.sessionId).toBe('test-session-123');
    expect(result.goal).toBeTruthy();
  });
});
