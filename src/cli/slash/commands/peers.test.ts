/**
 * Tests for the /peers slash command.
 *
 * Uses vi.mock to intercept readLivePresenceFiles so no real presence files
 * are created or read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { peersCmd } from './peers.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { PresenceRecord } from '../../../agent/awareness/presence.js';

// ---------------------------------------------------------------------------
// Mock readLivePresenceFiles so no disk I/O occurs
// ---------------------------------------------------------------------------

vi.mock('../../../agent/awareness/presence.js', () => ({
  readLivePresenceFiles: vi.fn(),
}));

import { readLivePresenceFiles } from '../../../agent/awareness/presence.js';
const mockRead = readLivePresenceFiles as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 1,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
    sessionId: 'self-session-abc123',
    ...overrides,
  };
}

function makeCtx(stats: SessionStats): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: {} as SlashContext['session'],
    stats,
    out: {
      line: (t = ''): void => { lines.push(`LINE:${t}`); },
      raw: (t): void => { lines.push(`RAW:${t}`); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, lines };
}

function makeRecord(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    sessionId: 'peer-abc12345',
    surface: 'cli',
    cwd: '/home/user/projects/myproject',
    startedAt: new Date().toISOString(),
    model: { provider: 'anthropic', name: 'claude-sonnet' },
    workspace: { branch: 'main', headSha: 'abc', dirty: false, dirtyCount: 0, remoteUrl: undefined },
    pid: 12345,
    path: '/fake/path',
    liveness: 'alive',
    heartbeatAgeMs: 5000,
    name: 'worker',
    turnState: 'idle',
    peerInbox: true,
    ...overrides,
  } as PresenceRecord;
}

// Strip ANSI escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function clean(lines: string[]): string {
  return lines.map((l) => l.replace(ANSI, '')).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockRead.mockReset();
});

describe('/peers', () => {
  it('shows "no other live sessions" when the only record is self', async () => {
    mockRead.mockResolvedValue([makeRecord({ sessionId: 'self-session-abc123' })]);
    const { ctx, lines } = makeCtx(makeStats());
    const result = await peersCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(clean(lines)).toMatch(/no other live sessions/i);
  });

  it('lists peer sessions excluding self', async () => {
    const peer = makeRecord({ sessionId: 'peer-xyz98765', name: 'research' });
    mockRead.mockResolvedValue([
      makeRecord({ sessionId: 'self-session-abc123' }),
      peer,
    ]);
    const { ctx, lines } = makeCtx(makeStats());
    await peersCmd.handler(ctx, '');
    const output = clean(lines);
    expect(output).toContain('peer-xyz');  // short id (first 8 chars)
    expect(output).toContain('research');
    expect(output).not.toContain('self-session');
  });

  it('shows surface, turnState, peerInbox, cwd basename, branch', async () => {
    const peer = makeRecord({
      sessionId: 'peer-peer12345',
      surface: 'cli',
      turnState: 'busy',
      peerInbox: true,
      cwd: '/home/user/mydir',
      workspace: {
        branch: 'feat/x',
        headSha: 'abc',
        dirty: false,
        dirtyCount: 0,
        remoteUrl: undefined,
      },
    });
    mockRead.mockResolvedValue([peer]);
    const { ctx, lines } = makeCtx(makeStats());
    await peersCmd.handler(ctx, '');
    const output = clean(lines);
    expect(output).toContain('cli');
    expect(output).toContain('busy');
    expect(output).toContain('yes');  // peerInbox
    expect(output).toContain('mydir');
    expect(output).toContain('feat/x');
  });

  it('shows "no peer sessions found" when no records exist and no self id', async () => {
    mockRead.mockResolvedValue([]);
    const { ctx, lines } = makeCtx(makeStats({ sessionId: undefined }));
    await peersCmd.handler(ctx, '');
    expect(clean(lines)).toMatch(/no peer sessions found/i);
  });
});
