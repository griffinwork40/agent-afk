/**
 * Tests for startup-recall.ts
 *
 * Strategy: mock getOrDeriveFacet, getSessionsDir, and the node:fs calls so
 * we can exercise the formatting and suppression logic without touching disk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- mocks declared before any imports of the module under test ---

vi.mock('../../../paths.js', () => ({
  getSessionsDir: vi.fn(() => '/fake/sessions'),
}));

vi.mock('../../../agent/facets/store.js', () => ({
  getOrDeriveFacet: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    openSync: vi.fn(() => 99),
    readSync: vi.fn(),
    closeSync: vi.fn(),
  };
});

// --- import module under test and mocked helpers after vi.mock calls ---

import { readdirSync, statSync, readSync } from 'node:fs';
import { getSessionsDir } from '../../../paths.js';
import { getOrDeriveFacet } from '../../../agent/facets/store.js';
import { renderStartupRecall, formatTimeAgo } from './startup-recall.js';
import type { SessionFacet } from '../../../agent/facets/schema.js';

const mockReaddirSync = readdirSync as unknown as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as unknown as ReturnType<typeof vi.fn>;
const mockReadSync = readSync as unknown as ReturnType<typeof vi.fn>;
const mockGetOrDeriveFacet = getOrDeriveFacet as unknown as ReturnType<typeof vi.fn>;
const mockGetSessionsDir = getSessionsDir as unknown as ReturnType<typeof vi.fn>;

// Minimal valid facet fixture.
function makeFacet(overrides: Partial<SessionFacet> = {}): SessionFacet {
  return {
    facet_version: 13,
    session_id: 'abc123',
    surface: 'cli',
    start_time: '2026-10-25T10:00:00.000Z',
    end_time: '2026-10-25T10:30:00.000Z',
    duration_minutes: 30,
    first_prompt: 'write some tests',
    goal_categories: {},
    session_type: 'implementation',
    brief_summary: 'fixed PR review feedback',
    total_turns: 12,
    outcome: 'fully_achieved',
    outcome_source: 'terminal_state',
    tool_counts: {},
    tool_errors: {},
    tool_errors_total: 0,
    world_changes: { files_written: 0, files_edited: 0, bash_mutations: 0 },
    primary_success: true,
    cost_usd: 0,
    subagent_count: 0,
    subagent_tool_summary: [],
    ...overrides,
  } as unknown as SessionFacet;
}

/**
 * Wire up mocks so that the sessions dir contains one sidecar whose cwd
 * matches the given cwd, and whose facet is returned by getOrDeriveFacet.
 */
function setupSingleSession(opts: {
  sessionId: string;
  cwd: string;
  facet: SessionFacet;
  mtimeMs?: number;
}): void {
  const { sessionId, cwd, facet, mtimeMs = Date.now() - 3 * 60 * 60 * 1000 } = opts;
  mockGetSessionsDir.mockReturnValue('/fake/sessions');
  mockReaddirSync.mockReturnValue([`${sessionId}.json`]);
  mockStatSync.mockReturnValue({ mtimeMs });

  // Make readSync write a buffer that contains a cwd field.
  mockReadSync.mockImplementation(
    (_fd: number, buf: Buffer, _offset: number, _length: number, _pos: number) => {
      const payload = JSON.stringify({ sessionId, cwd, surface: 'cli' });
      buf.write(payload, 0, 'utf8');
      return payload.length;
    },
  );

  mockGetOrDeriveFacet.mockReturnValue(facet);
}

const BASE_OPTS = {
  cwd: '/some/project',
  isResume: false,
  isTTY: true,
  isFirstRun: false,
  currentSessionId: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Suppression conditions
// ---------------------------------------------------------------------------

describe('renderStartupRecall — suppression', () => {
  it('returns undefined when isTTY is false', () => {
    const result = renderStartupRecall({ ...BASE_OPTS, isTTY: false });
    expect(result).toBeUndefined();
  });

  it('returns undefined when isResume is true', () => {
    const result = renderStartupRecall({ ...BASE_OPTS, isResume: true });
    expect(result).toBeUndefined();
  });

  it('returns undefined when isFirstRun is true', () => {
    const result = renderStartupRecall({ ...BASE_OPTS, isFirstRun: true });
    expect(result).toBeUndefined();
  });

  it('returns undefined when no session matches cwd', () => {
    mockGetSessionsDir.mockReturnValue('/fake/sessions');
    mockReaddirSync.mockReturnValue(['abc123.json']);
    mockStatSync.mockReturnValue({ mtimeMs: Date.now() });
    // readSync writes a different cwd.
    mockReadSync.mockImplementation(
      (_fd: number, buf: Buffer) => {
        const payload = JSON.stringify({ cwd: '/other/project' });
        buf.write(payload, 0, 'utf8');
        return payload.length;
      },
    );

    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeUndefined();
  });

  it('returns undefined when the only matching session is the current session', () => {
    setupSingleSession({
      sessionId: 'current-session',
      cwd: '/some/project',
      facet: makeFacet(),
    });

    const result = renderStartupRecall({
      ...BASE_OPTS,
      currentSessionId: 'current-session',
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when sessions dir is empty', () => {
    mockGetSessionsDir.mockReturnValue('/fake/sessions');
    mockReaddirSync.mockReturnValue([]);

    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeUndefined();
  });

  it('returns undefined when readdirSync throws', () => {
    mockGetSessionsDir.mockReturnValue('/fake/sessions');
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeUndefined();
  });

  it('skips unsealed sessions (no end_time) and returns undefined when no sealed match', () => {
    setupSingleSession({
      sessionId: 'live-session',
      cwd: '/some/project',
      facet: makeFacet({ end_time: undefined as unknown as string }),
    });

    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Happy path — formatted output
// ---------------------------------------------------------------------------

describe('renderStartupRecall — cwd matching', () => {
  it('matches cwd with JSON-escaped backslashes (Windows paths)', () => {
    const winCwd = 'C:\\Users\\foo\\project';
    setupSingleSession({
      sessionId: 'win-sess',
      cwd: winCwd,
      facet: makeFacet(),
    });

    const result = renderStartupRecall({ ...BASE_OPTS, cwd: winCwd });
    expect(result).toBeDefined();
    expect(result).toContain('Done');
  });
});

describe('renderStartupRecall — formatted output', () => {
  it('contains the outcome label for fully_achieved', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ outcome: 'fully_achieved', brief_summary: 'refactored auth module' }),
    });

    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeDefined();
    expect(result).toContain('Done');
  });

  it('contains "Partial" for partially_achieved', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ outcome: 'partially_achieved' }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toContain('Partial');
  });

  it('contains "Failed" for not_achieved', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ outcome: 'not_achieved' }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toContain('Failed');
  });

  it('contains "Aborted" for aborted', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ outcome: 'aborted' }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toContain('Aborted');
  });

  it('omits outcome label for unknown outcome', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ outcome: 'unknown', brief_summary: 'something happened' }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeDefined();
    expect(result).not.toContain('Done');
    expect(result).not.toContain('Partial');
    expect(result).not.toContain('Failed');
    expect(result).not.toContain('Aborted');
  });

  it('contains turn count', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ total_turns: 7 }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toContain('7 turns');
  });

  it('prefixes with "  last:"', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet(),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    // Strip ANSI escape codes before checking prefix.
    const stripped = result?.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toMatch(/^\s+last:/);
  });
});

// ---------------------------------------------------------------------------
// Summary truncation
// ---------------------------------------------------------------------------

describe('renderStartupRecall — truncation', () => {
  it('truncates long brief_summary to ~50 chars', () => {
    const longSummary = 'a'.repeat(80);
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ brief_summary: longSummary }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeDefined();
    // The raw summary should not appear untruncated.
    expect(result).not.toContain(longSummary);
    // But the truncated prefix should be present (50 chars = 49 + ellipsis).
    expect(result).toContain('a'.repeat(49) + '…');
  });

  it('falls back to first_prompt when brief_summary is empty', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ brief_summary: '', first_prompt: 'write some tests' }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeDefined();
    expect(result).toContain('write some tests');
  });

  it('falls back to first_prompt when brief_summary is whitespace-only', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ brief_summary: '   ', first_prompt: 'debug the crash' }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toContain('debug the crash');
  });

  it('truncates long first_prompt fallback to ~40 chars', () => {
    const longPrompt = 'b'.repeat(60);
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ brief_summary: '', first_prompt: longPrompt }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).not.toContain(longPrompt);
    expect(result).toContain('b'.repeat(39) + '…');
  });

  it('still renders (with turns) when both summary and first_prompt are empty', () => {
    setupSingleSession({
      sessionId: 'sess1',
      cwd: '/some/project',
      facet: makeFacet({ brief_summary: '', first_prompt: '', total_turns: 5 }),
    });
    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeDefined();
    expect(result).toContain('5 turns');
  });
});

// ---------------------------------------------------------------------------
// Edge-case scan behaviour
// ---------------------------------------------------------------------------

describe('renderStartupRecall — getOrDeriveFacet undefined fallthrough', () => {
  it('skips entries where getOrDeriveFacet returns undefined and finds the next match', () => {
    mockGetSessionsDir.mockReturnValue('/fake/sessions');
    // Two sidecars, both matching cwd. First returns undefined from facet store;
    // second returns a valid sealed facet — verifies the scan continues.
    mockReaddirSync.mockReturnValue(['first.json', 'second.json']);
    mockStatSync.mockImplementation((_p: string) => ({ mtimeMs: Date.now() }));
    mockReadSync.mockImplementation(
      (_fd: number, buf: Buffer, _offset: number, _length: number, _pos: number) => {
        const payload = JSON.stringify({ cwd: '/some/project' });
        buf.write(payload, 0, 'utf8');
        return payload.length;
      },
    );
    // first.json → undefined (no facet derived); second.json → valid sealed facet.
    mockGetOrDeriveFacet
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(makeFacet({ session_id: 'second', brief_summary: 'second session' }));

    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeDefined();
    expect(result).toContain('second session');
  });
});

describe('renderStartupRecall — MAX_SCAN boundary', () => {
  it('silently skips sessions beyond MAX_SCAN (entry 31+) and returns undefined', () => {
    mockGetSessionsDir.mockReturnValue('/fake/sessions');
    // 31 sidecars all matching cwd, but only entry index 30 (the 31st) has a
    // valid sealed facet — it must be silently excluded by the .slice(0, 30) cap.
    const files = Array.from({ length: 31 }, (_, i) => `sess${i}.json`);
    mockReaddirSync.mockReturnValue(files);
    mockStatSync.mockImplementation((_p: string) => ({ mtimeMs: Date.now() }));
    mockReadSync.mockImplementation(
      (_fd: number, buf: Buffer, _offset: number, _length: number, _pos: number) => {
        const payload = JSON.stringify({ cwd: '/some/project' });
        buf.write(payload, 0, 'utf8');
        return payload.length;
      },
    );
    // First 30 entries return undefined; the 31st (index 30) returns a valid facet.
    mockGetOrDeriveFacet.mockReturnValue(undefined);
    // The 31st call should never happen because MAX_SCAN=30 slices it out.

    const result = renderStartupRecall({ ...BASE_OPTS });
    expect(result).toBeUndefined();
    // getOrDeriveFacet should have been called at most MAX_SCAN (30) times.
    expect(mockGetOrDeriveFacet.mock.calls.length).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// formatTimeAgo — unit tests with fake timers
// ---------------------------------------------------------------------------

describe('formatTimeAgo', () => {
  const NOW = new Date('2026-10-25T16:00:00.000Z');

  it('returns "just now" for sub-minute difference', () => {
    const then = new Date(NOW.getTime() - 30_000).toISOString();
    expect(formatTimeAgo(then, NOW)).toBe('just now');
  });

  it('returns "just now" for future timestamps', () => {
    const then = new Date(NOW.getTime() + 5_000).toISOString();
    expect(formatTimeAgo(then, NOW)).toBe('just now');
  });

  it('returns minutes ago', () => {
    const then = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    expect(formatTimeAgo(then, NOW)).toBe('5m ago');
  });

  it('returns hours ago', () => {
    const then = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    expect(formatTimeAgo(then, NOW)).toBe('3h ago');
  });

  it('returns days ago', () => {
    const then = new Date(NOW.getTime() - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatTimeAgo(then, NOW)).toBe('2d ago');
  });

  it('returns empty string for an invalid ISO string', () => {
    expect(formatTimeAgo('not-a-date', NOW)).toBe('');
  });

  it('returns "just now" at exactly 0ms difference', () => {
    expect(formatTimeAgo(NOW.toISOString(), NOW)).toBe('just now');
  });
});
