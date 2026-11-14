/**
 * Tests for `renderStartupDashboard`.
 *
 * Strategy: mock both data sources (`readLivePresenceFiles` and
 * `loadSchedules`) and drive the function through every branch. Palette
 * calls are left live — chalk strips color in test environments (level 0),
 * so assertions compare plain text rather than escape sequences.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../agent/awareness/presence.js', () => ({
  readLivePresenceFiles: vi.fn(),
}));

vi.mock('../../../agent/daemon/schedule-store.js', () => ({
  loadSchedules: vi.fn(),
}));

import { readLivePresenceFiles } from '../../../agent/awareness/presence.js';
import { loadSchedules } from '../../../agent/daemon/schedule-store.js';
import { renderStartupDashboard } from './startup-dashboard.js';

const mockReadLivePresenceFiles = readLivePresenceFiles as ReturnType<typeof vi.fn>;
const mockLoadSchedules = loadSchedules as ReturnType<typeof vi.fn>;

/** Minimal presence record shape matching PresenceRecord. */
function makePresenceRecord(overrides: { surface?: string; sessionId?: string } = {}) {
  return {
    sessionId: overrides.sessionId ?? 'peer-1',
    surface: overrides.surface ?? 'cli',
    liveness: 'alive' as const,
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    model: { provider: 'anthropic', name: 'sonnet' },
    workspace: { branch: 'main', isDirty: false },
    pid: 12345,
    path: '/tmp/peer-1.json',
    heartbeatAgeMs: null,
  };
}

beforeEach(() => {
  mockReadLivePresenceFiles.mockResolvedValue([]);
  mockLoadSchedules.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

describe('skip conditions', () => {
  it('returns [] when isTTY is false', async () => {
    const result = await renderStartupDashboard({
      isTTY: false,
      isFirstRun: false,
      bootPruneStaleCount: 3,
    });
    expect(result).toEqual([]);
    expect(mockReadLivePresenceFiles).not.toHaveBeenCalled();
    expect(mockLoadSchedules).not.toHaveBeenCalled();
  });

  it('returns [] when isFirstRun is true', async () => {
    const result = await renderStartupDashboard({
      isTTY: true,
      isFirstRun: true,
      bootPruneStaleCount: 3,
    });
    expect(result).toEqual([]);
    expect(mockReadLivePresenceFiles).not.toHaveBeenCalled();
    expect(mockLoadSchedules).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stale worktrees
// ---------------------------------------------------------------------------

describe('stale worktrees', () => {
  it('omits worktree item when bootPruneStaleCount is 0', async () => {
    const result = await renderStartupDashboard({
      isTTY: true,
      isFirstRun: false,
      bootPruneStaleCount: 0,
    });
    expect(result.join('\n')).not.toContain('worktree');
  });

  it('omits worktree item when bootPruneStaleCount is absent', async () => {
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result.join('\n')).not.toContain('worktree');
  });

  it('shows singular "1 stale worktree" when count is 1', async () => {
    const result = await renderStartupDashboard({
      isTTY: true,
      isFirstRun: false,
      bootPruneStaleCount: 1,
    });
    expect(result[0]).toContain('1 stale worktree');
    expect(result[0]).not.toContain('worktrees');
  });

  it('shows plural "3 stale worktrees" when count is 3', async () => {
    const result = await renderStartupDashboard({
      isTTY: true,
      isFirstRun: false,
      bootPruneStaleCount: 3,
    });
    expect(result[0]).toContain('3 stale worktrees');
  });
});

// ---------------------------------------------------------------------------
// Live peer sessions
// ---------------------------------------------------------------------------

describe('live peers', () => {
  it('omits peer item when no presence records exist', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result.join('\n')).not.toContain('peer');
  });

  it('omits peer item when presence records have non-cli surface', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([
      makePresenceRecord({ surface: 'daemon' }),
      makePresenceRecord({ surface: 'telegram' }),
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result.join('\n')).not.toContain('peer');
  });

  it('shows "1 peer live" (singular) for one cli session', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([makePresenceRecord({ surface: 'cli' })]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result[0]).toContain('1 peer live');
    expect(result[0]).not.toContain('peers');
  });

  it('shows "2 peers live" (plural) for two cli sessions', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([
      makePresenceRecord({ sessionId: 'peer-1', surface: 'cli' }),
      makePresenceRecord({ sessionId: 'peer-2', surface: 'cli' }),
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result[0]).toContain('2 peers live');
  });

  it('counts only cli sessions, not mixed surfaces', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([
      makePresenceRecord({ sessionId: 'a', surface: 'cli' }),
      makePresenceRecord({ sessionId: 'b', surface: 'daemon' }),
      makePresenceRecord({ sessionId: 'c', surface: 'cli' }),
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result[0]).toContain('2 peers live');
  });
});

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

describe('scheduled tasks', () => {
  it('omits daemon line when no schedules exist', async () => {
    mockLoadSchedules.mockReturnValue([]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result.join('\n')).not.toContain('scheduled task');
  });

  it('omits daemon line when all schedules are disabled', async () => {
    mockLoadSchedules.mockReturnValue([
      { id: 'task-1', enabled: false, name: 'nightly', cron: '0 2 * * *' },
      { id: 'task-2', enabled: false, name: 'hourly', cron: '0 * * * *' },
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result.join('\n')).not.toContain('scheduled task');
  });

  it('shows "1 scheduled task" (singular) for one enabled task', async () => {
    mockLoadSchedules.mockReturnValue([
      { id: 'task-1', enabled: true, name: 'nightly', cron: '0 2 * * *' },
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    const joined = result.join('\n');
    expect(joined).toContain('1 scheduled task');
    expect(joined).not.toContain('scheduled tasks');
  });

  it('shows "2 scheduled tasks" (plural) for two enabled tasks', async () => {
    mockLoadSchedules.mockReturnValue([
      { id: 'task-1', enabled: true, name: 'nightly', cron: '0 2 * * *' },
      { id: 'task-2', enabled: true, name: 'hourly', cron: '0 * * * *' },
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result.join('\n')).toContain('2 scheduled tasks');
  });

  it('counts only enabled tasks, ignoring disabled ones', async () => {
    mockLoadSchedules.mockReturnValue([
      { id: 'task-1', enabled: true, name: 'nightly', cron: '0 2 * * *' },
      { id: 'task-2', enabled: false, name: 'skipped', cron: '0 * * * *' },
      { id: 'task-3', enabled: true, name: 'weekly', cron: '0 0 * * 0' },
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result.join('\n')).toContain('2 scheduled tasks');
  });
});

// ---------------------------------------------------------------------------
// Line composition
// ---------------------------------------------------------------------------

describe('line composition', () => {
  it('returns [] when all sources are empty', async () => {
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result).toEqual([]);
  });

  it('returns only line 1 when only local items exist', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([makePresenceRecord()]);
    mockLoadSchedules.mockReturnValue([]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('peer');
  });

  it('returns only line 2 when only daemon items exist', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([]);
    mockLoadSchedules.mockReturnValue([
      { id: 'task-1', enabled: true, name: 'nightly', cron: '0 2 * * *' },
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('scheduled task');
  });

  it('returns 2 lines when both local and daemon items exist', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([makePresenceRecord()]);
    mockLoadSchedules.mockReturnValue([
      { id: 'task-1', enabled: true, name: 'nightly', cron: '0 2 * * *' },
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('peer');
    expect(result[1]).toContain('scheduled task');
  });

  it('joins multiple local items with " · "', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([makePresenceRecord()]);
    const result = await renderStartupDashboard({
      isTTY: true,
      isFirstRun: false,
      bootPruneStaleCount: 2,
    });
    expect(result[0]).toContain('2 stale worktrees · 1 peer live');
  });

  it('prefixes each line with the ◈ glyph', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([makePresenceRecord()]);
    mockLoadSchedules.mockReturnValue([
      { id: 'task-1', enabled: true, name: 'nightly', cron: '0 2 * * *' },
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    for (const line of result) {
      expect(line).toContain('◈');
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('omits peer item gracefully when readLivePresenceFiles throws', async () => {
    mockReadLivePresenceFiles.mockRejectedValue(new Error('ENOENT'));
    mockLoadSchedules.mockReturnValue([
      { id: 'task-1', enabled: true, name: 'nightly', cron: '0 2 * * *' },
    ]);
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('scheduled task');
    expect(result[0]).not.toContain('peer');
  });

  it('omits daemon item gracefully when loadSchedules throws', async () => {
    mockReadLivePresenceFiles.mockResolvedValue([makePresenceRecord()]);
    mockLoadSchedules.mockImplementation(() => { throw new Error('parse error'); });
    const result = await renderStartupDashboard({ isTTY: true, isFirstRun: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('peer');
    expect(result[0]).not.toContain('scheduled task');
  });

  it('returns [] when both sources throw', async () => {
    mockReadLivePresenceFiles.mockRejectedValue(new Error('ENOENT'));
    mockLoadSchedules.mockImplementation(() => { throw new Error('parse error'); });
    await expect(
      renderStartupDashboard({ isTTY: true, isFirstRun: false }),
    ).resolves.toEqual([]);
  });
});
