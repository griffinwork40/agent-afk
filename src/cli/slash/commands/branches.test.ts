/**
 * `/branches` slash command tests (#4294).
 *
 * Verifies the handler:
 *   - Reports "no branches" when there is only one session in the tree.
 *   - Lists all sessions sharing a forkedFrom ancestor.
 *   - Marks the current session with the current marker.
 *   - Switch subcommand resolves by id prefix and calls requestResume.
 *   - Switch subcommand rejects ambiguous prefixes and unknown ids.
 *   - Switch to current branch is a no-op.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { SlashContext, SessionStats } from '../types.js';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before the import under test.
// ---------------------------------------------------------------------------

vi.mock('../../session-store.js', () => ({
  loadSession: vi.fn(),
  listSessions: vi.fn(),
  findSession: vi.fn(),
}));

vi.mock('../../resume-command.js', () => ({
  formatResumeCommand: vi.fn((id: string) => `afk interactive --resume ${id}`),
}));

import { branchesCmd } from './branches.js';
import { loadSession, listSessions, findSession } from '../../session-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const loadSessionMock = loadSession as Mock;
const listSessionsMock = listSessions as Mock;
const findSessionMock = findSession as Mock;

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 2,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    unpricedTurns: 0,
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    sessionId: 'session-aaa',
    permissionMode: 'default',
    ...overrides,
  };
}

function makeCtx(overrides: {
  sessionId?: string;
  requestResume?: Mock;
} = {}): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const stats = makeStats({ sessionId: overrides.sessionId ?? 'session-aaa' });

  const ctx: SlashContext = {
    session: {
      current: {
        messageJournal: undefined,
        listRewindTargets: vi.fn(() => []),
        rewindConversation: vi.fn(),
      },
    } as unknown as SlashContext['session'],
    stats,
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t: string): void => { lines.push(t); },
      success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
      info: (t: string): void => { lines.push(`INFO:${t}`); },
      warn: (t: string): void => { lines.push(`WARN:${t}`); },
      error: (t: string): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    ledger: undefined as unknown as SlashContext['ledger'],
    capabilities: undefined,
    requestResume: overrides.requestResume,
  } as unknown as SlashContext;

  return { ctx, lines };
}

// ---------------------------------------------------------------------------
// Shared sidecar data
// ---------------------------------------------------------------------------

const SESSION_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SESSION_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const SESSION_C = 'cccccccc-1111-2222-3333-444444444444';
const SESSION_X = 'xxxxxxxx-unrelated-0000-000000000000';

/** List entries (no forkedFrom here — that comes from loadSession). */
const entryA = {
  id: SESSION_A,
  sessionId: SESSION_A,
  model: 'sonnet',
  savedAt: 3000,
  totalTurns: 5,
};
const entryB = {
  id: SESSION_B,
  sessionId: SESSION_B,
  model: 'sonnet',
  savedAt: 2000,
  totalTurns: 3,
};
const entryC = {
  id: SESSION_C,
  sessionId: SESSION_C,
  model: 'sonnet',
  savedAt: 1000,
  totalTurns: 1,
};
const entryX = {
  id: SESSION_X,
  sessionId: SESSION_X,
  model: 'haiku',
  savedAt: 5000,
  totalTurns: 10,
};

/** Sidecar for A: forked from C (A is the new path after rewinding C → B → A). */
const sidecarA = { sessionId: SESSION_A, model: 'sonnet', savedAt: 3000, totalTurns: 5, forkedFrom: SESSION_B };
/** Sidecar for B: forked from C. */
const sidecarB = { sessionId: SESSION_B, model: 'sonnet', savedAt: 2000, totalTurns: 3, forkedFrom: SESSION_C };
/** Sidecar for C: root (no forkedFrom). */
const sidecarC = { sessionId: SESSION_C, model: 'sonnet', savedAt: 1000, totalTurns: 1 };
/** Sidecar for X: unrelated root. */
const sidecarX = { sessionId: SESSION_X, model: 'haiku', savedAt: 5000, totalTurns: 10 };

function setupSidecars(): void {
  loadSessionMock.mockImplementation((id: string) => {
    if (id === SESSION_A) return sidecarA;
    if (id === SESSION_B) return sidecarB;
    if (id === SESSION_C) return sidecarC;
    if (id === SESSION_X) return sidecarX;
    return undefined;
  });
  listSessionsMock.mockReturnValue([entryX, entryA, entryB, entryC]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports no branches when only one session exists in the tree', async () => {
    loadSessionMock.mockReturnValue(sidecarC); // no forkedFrom
    listSessionsMock.mockReturnValue([entryC]);

    const { ctx, lines } = makeCtx({ sessionId: SESSION_C });
    const result = await branchesCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('No branches yet'))).toBe(true);
  });

  it('lists all branches in the tree, marking the current one', async () => {
    setupSidecars();
    const { ctx, lines } = makeCtx({ sessionId: SESSION_A });
    const result = await branchesCmd.handler(ctx, '');
    expect(result).toBe('continue');

    // Should show 3 branches (A, B, C) but not X.
    const heading = lines.find((l) => l.includes('3 branch'));
    expect(heading).toBeTruthy();

    // The current branch (A) should appear with the marker.
    const currentLine = lines.find((l) => l.includes('▶'));
    expect(currentLine).toBeTruthy();
    expect(currentLine).toContain(SESSION_A.slice(0, 8));
  });

  it('warns when no sessionId is available', async () => {
    const { ctx, lines } = makeCtx({ sessionId: undefined });
    // Override stats to have no sessionId.
    ctx.stats.sessionId = undefined;
    const result = await branchesCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('No session id'))).toBe(true);
  });

  describe('switch subcommand', () => {
    it('switches to a branch by id prefix using requestResume', async () => {
      setupSidecars();
      const requestResume = vi.fn().mockResolvedValue({ ok: true, sessionId: SESSION_B });
      findSessionMock.mockReturnValue({ id: SESSION_B, data: sidecarB });

      const { ctx, lines } = makeCtx({ sessionId: SESSION_A, requestResume });
      // Use a prefix unique to SESSION_B (first 4 chars 'bbbb')
      const result = await branchesCmd.handler(ctx, `switch bbbb`);
      expect(result).toBe('continue');
      expect(requestResume).toHaveBeenCalledOnce();
      expect(lines.some((l) => l.includes('Switching'))).toBe(true);
    });

    it('falls back to printing the command when requestResume is unavailable', async () => {
      setupSidecars();
      findSessionMock.mockReturnValue(undefined); // findSession returns nothing

      const { ctx, lines } = makeCtx({ sessionId: SESSION_A });
      // Use a prefix unique to SESSION_B (first 4 chars 'bbbb')
      const result = await branchesCmd.handler(ctx, `switch bbbb`);
      expect(result).toBe('continue');
      // Should print the resume command as fallback.
      expect(lines.some((l) => l.includes('afk interactive --resume'))).toBe(true);
    });

    it('rejects ambiguous id prefixes', async () => {
      setupSidecars();
      const { ctx, lines } = makeCtx({ sessionId: SESSION_A });
      // '1111' is a suffix-prefix shared by A, B, C but not X — however,
      // the ids all start with unique first chars, so use a prefix shared
      // by two: none of aaaa/bbbb/cccc share a prefix beyond ''. Instead,
      // use a direct exact-prefix of the 8-char shortId block that covers
      // two entries; easiest is a prefix of SESSION_A's sessionId that
      // also matches SESSION_B's sessionId field — impossible with our test
      // data, so we add a second entry with the same id prefix instead.
      // Simplest: use the listSessions mock to return two entries with ids
      // starting with 'aabbcc' and assert ambiguity.

      // Two entries sharing prefix 'aabbcc', both in the same branch tree
      // (P2 forkedFrom P1 so they share the same root = P1).
      const idP1 = 'aabbccdd-p1-0000-0000-000000000000';
      const idP2 = 'aabbccee-p2-0000-0000-000000000000';
      loadSessionMock.mockImplementation((id: string) => {
        if (id === idP1) return { sessionId: idP1, model: 'sonnet', savedAt: 100, totalTurns: 1 };
        if (id === idP2) return { sessionId: idP2, model: 'sonnet', savedAt: 200, totalTurns: 2, forkedFrom: idP1 };
        return undefined;
      });
      listSessionsMock.mockReturnValue([
        { id: idP1, sessionId: idP1, model: 'sonnet', savedAt: 100, totalTurns: 1 },
        { id: idP2, sessionId: idP2, model: 'sonnet', savedAt: 200, totalTurns: 2 },
      ]);
      const ambigCtx = makeCtx({ sessionId: idP1 });
      const result2 = await branchesCmd.handler(ambigCtx.ctx, 'switch aabbcc');
      expect(result2).toBe('continue');
      expect(ambigCtx.lines.some((l) => l.includes('Ambiguous'))).toBe(true);
    });

    it('rejects unknown ids', async () => {
      setupSidecars();
      const { ctx, lines } = makeCtx({ sessionId: SESSION_A });
      const result = await branchesCmd.handler(ctx, 'switch zzzzzzzz');
      expect(result).toBe('continue');
      expect(lines.some((l) => l.includes('No branch found'))).toBe(true);
    });

    it('no-ops when switching to the current branch', async () => {
      setupSidecars();
      const { ctx, lines } = makeCtx({ sessionId: SESSION_A });
      // Use a prefix unique to SESSION_A (first 4 chars 'aaaa')
      const result = await branchesCmd.handler(ctx, `switch aaaa`);
      expect(result).toBe('continue');
      expect(lines.some((l) => l.includes('Already on this branch'))).toBe(true);
    });

    it('warns on missing id argument', async () => {
      setupSidecars();
      const { ctx, lines } = makeCtx({ sessionId: SESSION_A });
      const result = await branchesCmd.handler(ctx, 'switch');
      expect(result).toBe('continue');
      expect(lines.some((l) => l.includes('Usage:'))).toBe(true);
    });

    it('does not route /branches switchfoo as a switch subcommand', async () => {
      setupSidecars();
      const { ctx, lines } = makeCtx({ sessionId: SESSION_A });
      // "switchfoo" has no word boundary — must fall through to the list path.
      const result = await branchesCmd.handler(ctx, 'switchfoo');
      expect(result).toBe('continue');
      // List path emits the branch-count heading, not "No branch found" / "Usage:".
      expect(lines.some((l) => l.includes('branch'))).toBe(true);
      expect(lines.some((l) => l.includes('Usage:'))).toBe(false);
      expect(lines.some((l) => l.includes('No branch found'))).toBe(false);
    });

    it('warns when requestResume is present but findSession returns undefined (TOCTOU)', async () => {
      setupSidecars();
      const requestResume = vi.fn().mockResolvedValue({ ok: true });
      findSessionMock.mockReturnValue(undefined); // TOCTOU: session vanished

      const { ctx, lines } = makeCtx({ sessionId: SESSION_A, requestResume });
      const result = await branchesCmd.handler(ctx, 'switch bbbb');
      expect(result).toBe('continue');
      // requestResume must NOT have been called (no target to pass).
      expect(requestResume).not.toHaveBeenCalled();
      // Should emit a warning about session not found.
      expect(lines.some((l) => l.includes('not found'))).toBe(true);
      // Falls back to printing the resume command.
      expect(lines.some((l) => l.includes('afk interactive --resume'))).toBe(true);
    });

    it('falls back to resume command when requestResume returns { ok: false }', async () => {
      setupSidecars();
      const requestResume = vi.fn().mockResolvedValue({ ok: false });
      findSessionMock.mockReturnValue({ id: SESSION_B, data: sidecarB });

      const { ctx, lines } = makeCtx({ sessionId: SESSION_A, requestResume });
      const result = await branchesCmd.handler(ctx, 'switch bbbb');
      expect(result).toBe('continue');
      expect(requestResume).toHaveBeenCalledOnce();
      // Success banner must NOT appear (swap failed).
      expect(lines.some((l) => l.includes('Switching'))).toBe(false);
      // Falls back to printing the resume command.
      expect(lines.some((l) => l.includes('afk interactive --resume'))).toBe(true);
    });
  });
});
