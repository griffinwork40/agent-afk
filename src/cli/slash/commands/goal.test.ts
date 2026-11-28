/**
 * Command-layer tests for /goal handler (goal.ts).
 *
 * Covers the two paths called out in issue #5386 (PR #5382 review findings F4 & F5):
 *   F4 — `/goal undo`  (success path and empty-archive path)
 *   F5 — bare-text guard  (existing goal warns; no existing goal sets normally)
 *
 * The goal-store functions and projectKeyForCwd are mocked so these tests
 * exercise only the CLI handler logic, not the SQLite persistence layer
 * (which is already covered by goal-store.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashContext, SessionStats } from '../types.js';

// Mock store functions and projectKeyForCwd before importing the handler.
vi.mock('../../../agent/goals/index.js', () => ({
  getGoal: vi.fn(),
  setGoal: vi.fn(),
  pauseGoal: vi.fn(),
  resumeGoal: vi.fn(),
  completeGoal: vi.fn(),
  clearGoal: vi.fn(),
  restoreGoal: vi.fn(),
}));

vi.mock('../../../agent/goals/goal-utils.js', () => ({
  projectKeyForCwd: vi.fn(() => 'test-project'),
}));

import { goalCmd } from './goal.js';
import {
  getGoal,
  setGoal,
  restoreGoal,
} from '../../../agent/goals/index.js';

const mockGetGoal = vi.mocked(getGoal);
const mockSetGoal = vi.mocked(setGoal);
const mockRestoreGoal = vi.mocked(restoreGoal);

function makeCtx(cwdOverride = '/repo'): { ctx: SlashContext; out: Record<string, string[]> } {
  const out: Record<string, string[]> = {
    success: [],
    info: [],
    warn: [],
    line: [],
  };
  const stats: Partial<SessionStats> = {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    cwd: cwdOverride,
    sessionId: 'test-session-id',
  };
  const ctx: SlashContext = {
    session: {} as SlashContext['session'],
    stats: stats as SessionStats,
    out: {
      line: (t = '') => { out['line']!.push(t); },
      raw: (t) => { out['line']!.push(t); },
      success: (t) => { out['success']!.push(t); },
      info: (t) => { out['info']!.push(t); },
      warn: (t) => { out['warn']!.push(t); },
      error: (t) => { out['warn']!.push(t); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, out };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// F4 — /goal undo
// ---------------------------------------------------------------------------

describe('/goal undo', () => {
  it('success path: restoreGoal returns a goal → emits "Goal restored: <text>" + SESSION_NOTE', async () => {
    mockRestoreGoal.mockReturnValue({
      text: 'finish the refactor',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sessionId: 'some-session',
      projectKey: 'test-project',
    });

    const { ctx, out } = makeCtx();
    const result = await goalCmd.handler(ctx, 'undo');

    expect(result).toBe('continue');
    expect(out['success']).toHaveLength(1);
    expect(out['success']![0]).toContain('Goal restored:');
    expect(out['success']![0]).toContain('finish the refactor');
    expect(out['info']).toHaveLength(1);
    expect(out['info']![0]).toMatch(/takes effect at the start of the next session/i);
    expect(out['warn']).toHaveLength(0);
  });

  it('empty path: restoreGoal returns null → emits "Nothing to undo."', async () => {
    mockRestoreGoal.mockReturnValue(null);

    const { ctx, out } = makeCtx();
    const result = await goalCmd.handler(ctx, 'undo');

    expect(result).toBe('continue');
    expect(out['warn']).toHaveLength(1);
    expect(out['warn']![0]).toMatch(/nothing to undo/i);
    expect(out['success']).toHaveLength(0);
    expect(out['info']).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F5 — bare-text guard (default case)
// ---------------------------------------------------------------------------

describe('/goal <bare text> guard', () => {
  it('existing goal: warns with status-aware message and does NOT call setGoal', async () => {
    mockGetGoal.mockReturnValue({
      text: 'current objective',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sessionId: 'some-session',
      projectKey: 'test-project',
    });

    const { ctx, out } = makeCtx();
    const result = await goalCmd.handler(ctx, 'new objective text');

    expect(result).toBe('continue');
    // Should warn and mention the existing goal text
    expect(out['warn'].join('\n')).toMatch(/active goal exists/i);
    expect(out['warn'].join('\n')).toContain('current objective');
    // Must NOT mutate the store
    expect(mockSetGoal).not.toHaveBeenCalled();
  });

  it('existing paused goal: status-aware message capitalises "Paused"', async () => {
    mockGetGoal.mockReturnValue({
      text: 'paused objective',
      status: 'paused',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sessionId: 'some-session',
      projectKey: 'test-project',
    });

    const { ctx, out } = makeCtx();
    await goalCmd.handler(ctx, 'replacement text');

    expect(out['warn'].join('\n')).toMatch(/paused goal exists/i);
    expect(mockSetGoal).not.toHaveBeenCalled();
  });

  it('no existing goal: sets the goal normally and emits "Goal set: <text>" + SESSION_NOTE', async () => {
    mockGetGoal.mockReturnValue(null);
    mockSetGoal.mockReturnValue({
      text: 'brand new goal',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sessionId: 'test-session-id',
      projectKey: 'test-project',
    });

    const { ctx, out } = makeCtx();
    const result = await goalCmd.handler(ctx, 'brand new goal');

    expect(result).toBe('continue');
    expect(mockSetGoal).toHaveBeenCalledWith('brand new goal', 'test-session-id', 'test-project');
    expect(out['success']).toHaveLength(1);
    expect(out['success']![0]).toContain('Goal set:');
    expect(out['success']![0]).toContain('brand new goal');
    expect(out['info']).toHaveLength(1);
    expect(out['info']![0]).toMatch(/takes effect at the start of the next session/i);
    expect(out['warn']).toHaveLength(0);
  });
});
