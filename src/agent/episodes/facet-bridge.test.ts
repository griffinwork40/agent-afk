/**
 * Tests for the deterministic facet-to-episode bridge (facet-bridge.ts).
 *
 * Mocks getOrDeriveFacet and verifies the mapping from facet fields to
 * EpisodeRecord fields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionFacet } from '../facets/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal facet stub with the fields buildEpisodeFromFacet reads. */
function makeFacet(overrides: Partial<SessionFacet> = {}): SessionFacet {
  return {
    facet_version: 13,
    session_id: 'test-session-abc',
    source: 'cli',
    model: 'claude-sonnet-4-20250514',
    derived_at: '2026-01-01T00:00:00.000Z',
    derived_from: 'afk-session',
    source_session_path: '/tmp/session.json',
    source_session_mtime_ms: 0,
    subagent_persistence: 'none',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-01-01T01:00:00.000Z',
    duration_minutes: 60,
    underlying_goal: 'Refactor the auth module for dependency injection',
    first_prompt: 'refactor auth',
    goal_categories: { refactor: 1, security: 0.5 },
    session_type: 'implementation',
    brief_summary: 'Auth module refactored to use DI.',
    total_turns: 10,
    user_message_count: 3,
    assistant_message_count: 7,
    tool_counts: { edit_file: 5, read_file: 8, bash: 3 },
    commands: ['pnpm test', 'pnpm lint'],
    skills: ['diagnose', 'ship'],
    subagents: [],
    tool_errors: 0,
    tool_errors_total: 0,
    tool_error_categories: {},
    friction_counts: {},
    friction_detail: '',
    outcome: 'fully_achieved',
    outcome_source: 'terminal_state',
    primary_success: 'Auth module refactored with full test coverage',
    world_changes: { files_written: 3, files_deleted: 0, bash_commands: 3, git_commits: 1 },
    parallel_dispatch: { total_tool_calls: 16, parallel_calls: 4, parallel_ratio: 0.25 },
    yield_tracking: { produced_pr: false, pr_merged: null, pr_url: null },
    decisions: ['Use constructor injection', 'Keep backward compat'],
    evidence_pointers: ['src/auth.ts:42', 'src/auth.test.ts:10'],
    ...overrides,
  } as SessionFacet;
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
// Tests
// ---------------------------------------------------------------------------

describe('buildEpisodeFromFacet', () => {
  it('maps underlying_goal to goal', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet(),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.goal).toBe('Refactor the auth module for dependency injection');
  });

  it('maps primary_success to outcome', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet(),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.outcome).toBe('Auth module refactored with full test coverage');
  });

  it('builds approach from skills and commands', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet(),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.approach).toContain('Skills: diagnose, ship');
    expect(ep!.approach).toContain('Commands: pnpm test, pnpm lint');
  });

  it('falls back to top tools when skills and commands are empty', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet({ skills: [], commands: [] }),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.approach).toContain('Tools:');
    expect(ep!.approach).toContain('read_file');
  });

  it('maps all decisions from facet without truncation', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet({
        decisions: ['a', 'b', 'c', 'd', 'e'],
      }),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.decisions).toHaveLength(5);
    expect(ep!.decisions).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('maps evidence_pointers to filesKey (max 5)', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet(),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.filesKey).toEqual(['src/auth.ts:42', 'src/auth.test.ts:10']);
  });

  it('maps goal_categories keys to tags', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet(),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.tags).toContain('refactor');
    expect(ep!.tags).toContain('security');
  });

  it('produces a narrative combining goal, approach, and outcome', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet(),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.narrative).toContain('Refactor the auth module');
    expect(ep!.narrative).toContain('Auth module refactored');
  });

  it('returns null when facet is null', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => null,
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('missing-session');
    expect(ep).toBeNull();
  });

  it('returns null when getOrDeriveFacet throws', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => { throw new Error('boom'); },
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('error-session');
    expect(ep).toBeNull();
  });

  it('sets synthesizedAt to a valid ISO timestamp', async () => {
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet(),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(() => new Date(ep!.synthesizedAt)).not.toThrow();
    expect(new Date(ep!.synthesizedAt).toISOString()).toBe(ep!.synthesizedAt);
  });

  // --- surface-to-source mapping (#4645) ---

  it('surface field (v14+): uses facet.surface as episode source when present', async () => {
    // A v14 facet with surface='telegram' must set episode.source to 'telegram',
    // not fall through to facet.source.
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet({ facet_version: 14, source: 'cli', surface: 'telegram' }),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.source).toBe('telegram');
  });

  it('surface field (pre-v14 fallback): uses facet.source when surface is absent and source is not "unknown"', async () => {
    // A pre-v14 cached facet has no surface field; episode.source should fall
    // back to facet.source so old episodes still carry surface information.
    vi.doMock('../facets/store.js', () => ({
      getOrDeriveFacet: () => makeFacet({ facet_version: 13, source: 'daemon', surface: undefined }),
    }));
    const { buildEpisodeFromFacet } = await import('./facet-bridge.js');
    const ep = buildEpisodeFromFacet('test-session-abc');
    expect(ep!.source).toBe('daemon');
  });
});
