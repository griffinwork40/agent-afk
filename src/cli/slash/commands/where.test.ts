/**
 * Tests for /where slash command.
 *
 * Mocks `gatherWorkspace` to exercise three code paths:
 *  - non-git directory (headSha === null)
 *  - detached HEAD (branch === null, headSha present)
 *  - dirty === null (unknown working-tree status)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { RuntimeWorkspace } from '../../../agent/awareness/types.js';

// Mock gatherWorkspace before importing whereCmd so the module resolves the mock.
vi.mock('../../../agent/awareness/workspace-source.js', () => ({
  gatherWorkspace: vi.fn(),
}));

import { whereCmd } from './where.js';
import { gatherWorkspace } from '../../../agent/awareness/workspace-source.js';

const mockGatherWorkspace = vi.mocked(gatherWorkspace);

const NULL_WORKSPACE: RuntimeWorkspace = {
  branch: null,
  headSha: null,
  dirty: null,
  dirtyCount: null,
  remoteUrl: null,
};

function makeCtx(statsOverrides: Partial<SessionStats> = {}): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const write = (text = ''): void => { lines.push(stripEscapeSequences(text)); };
  const stats: SessionStats = {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
    cwd: '/some/cwd',
    ...statsOverrides,
  } as SessionStats;
  return {
    lines,
    ctx: {
      session: { current: {} } as SlashContext['session'],
      stats,
      out: { line: write, raw: write, success: write, info: write, warn: write, error: write },
      ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('/where', () => {
  it('shows "not a git repository" for a non-git directory (headSha === null)', async () => {
    mockGatherWorkspace.mockReturnValue({ ...NULL_WORKSPACE });

    const { ctx, lines } = makeCtx();
    const result = await whereCmd.handler(ctx, '');

    expect(result).toBe('continue');
    const joined = lines.join('\n');
    expect(joined).toContain('not a git repository');
    expect(joined).not.toContain('Branch');
    expect(joined).not.toContain('Working tree');
  });

  it('shows "(detached)" label for a detached HEAD (branch === null, headSha present)', async () => {
    mockGatherWorkspace.mockReturnValue({
      ...NULL_WORKSPACE,
      headSha: 'abc1234def5678',
      branch: null,
      dirty: false,
      dirtyCount: 0,
    });

    const { ctx, lines } = makeCtx();
    await whereCmd.handler(ctx, '');

    const joined = lines.join('\n');
    expect(joined).toContain('(detached)');
    expect(joined).toContain('abc1234def5678');
    expect(joined).not.toContain('not a git repository');
  });

  it('shows "unknown" working-tree status when dirty === null', async () => {
    mockGatherWorkspace.mockReturnValue({
      ...NULL_WORKSPACE,
      headSha: 'deadbeef',
      branch: 'main',
      dirty: null,
      dirtyCount: null,
    });

    const { ctx, lines } = makeCtx();
    await whereCmd.handler(ctx, '');

    const joined = lines.join('\n');
    expect(joined).toContain('unknown');
    expect(joined).not.toContain('dirty');
    expect(joined).not.toContain('clean');
  });

  it('uses displayName over name for session label (finding 2 — security)', async () => {
    mockGatherWorkspace.mockReturnValue({ ...NULL_WORKSPACE });

    const { ctx, lines } = makeCtx({ name: 'raw\x1b[31mname', displayName: 'safe-name' });
    await whereCmd.handler(ctx, '');

    const joined = lines.join('\n');
    expect(joined).toContain('safe-name');
    expect(joined).not.toContain('\x1b[31m');
  });

  it('uses "?" as fallback when dirtyCount is null but dirty is true (finding 3 — null guard)', async () => {
    mockGatherWorkspace.mockReturnValue({
      ...NULL_WORKSPACE,
      headSha: 'cafebabe',
      branch: 'feature',
      dirty: true,
      dirtyCount: null,
    });

    const { ctx, lines } = makeCtx();
    await whereCmd.handler(ctx, '');

    const joined = lines.join('\n');
    expect(joined).toContain('? dirty');
  });
});
