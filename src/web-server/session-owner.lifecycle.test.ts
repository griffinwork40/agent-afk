/**
 * Unit tests for session-owner.lifecycle.ts — mocking session-store
 * so no HOME redirect or real filesystem is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock("../agent/journal/index.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, forkJournal: vi.fn(), loadJournalMessages: vi.fn().mockReturnValue(null) };
});
vi.mock('../cli/session-store.js', () => ({
  forkStoredSession: vi.fn(),
  findSession: vi.fn(),
  listSessions: vi.fn(),
  saveSession: vi.fn(),
}));
vi.mock('../cli/format-utils.js', () => ({ formatCost: vi.fn(() => '$0.00') }));

import { createSessionStats, recordTurn } from '../cli/slash/session-stats.js';
import {
  forkStoredSession,
  findSession,
  listSessions,
  saveSession,
} from '../cli/session-store.js';
import type { SlashContext, SessionStats } from '../cli/slash/types.js';
import type { SessionOwner } from './session-owner.js';
import { forkJournal } from '../agent/journal/index.js';
import {
  handleWebExit,
  handleWebFork,
  handleWebResumeList,
  handleWebResumeTarget,
} from './session-owner.lifecycle.js';

const mockFork = vi.mocked(forkStoredSession);
const mockFind = vi.mocked(findSession);
const mockList = vi.mocked(listSessions);
const mockSave = vi.mocked(saveSession);

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  const stats = createSessionStats('claude-sonnet-4-5');
  stats.sessionId = randomUUID();
  stats.cwd = '/tmp/test-session';
  stats.source = 'web';
  return Object.assign(stats, overrides);
}

function makeSession(sessionId?: string) {
  return {
    sessionId: sessionId ?? randomUUID(),
    messageJournal: undefined,
  } as unknown as import('../agent/session/agent-session.js').AgentSession;
}

function makeCtx(stats: SessionStats, session?: ReturnType<typeof makeSession>): SlashContext {
  const out = {
    line: vi.fn(),
    raw: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as SlashContext['out'];
  return {
    stats,
    out,
    session: { current: session ?? makeSession(stats.sessionId) },
  } as unknown as SlashContext;
}

function makeOwner(newId = randomUUID()): SessionOwner {
  return {
    create: vi.fn().mockResolvedValue({ id: newId, cwd: '/tmp', model: 'sonnet', createdAt: new Date().toISOString() }),
  } as unknown as SessionOwner;
}

beforeEach(() => vi.clearAllMocks());

describe('handleWebExit', () => {
  it('returns { kind: exit }', async () => {
    const stats = makeStats();
    const ctx = makeCtx(stats);
    const result = await handleWebExit({} as SessionOwner, stats.sessionId!, ctx);
    expect(result).toEqual({ kind: 'exit' });
  });

  it('emits an info message', async () => {
    const stats = makeStats();
    const ctx = makeCtx(stats);
    await handleWebExit({} as SessionOwner, stats.sessionId!, ctx);
    expect(ctx.out.info).toHaveBeenCalledWith(expect.stringContaining('Session ended'));
  });

  it('calls saveSession with closeTime and exit-command reason', async () => {
    const stats = makeStats();
    const ctx = makeCtx(stats);
    await handleWebExit({} as SessionOwner, stats.sessionId!, ctx);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.any(String) }),
      stats.sessionId,
      { closeTime: true, exitReason: 'exit-command' },
    );
  });
});

describe('handleWebResumeList', () => {
  it('returns continue and informs when no sessions', async () => {
    mockList.mockReturnValue([]);
    const ctx = makeCtx(makeStats());
    const result = await handleWebResumeList(ctx);
    expect(result).toBe('continue');
    expect(ctx.out.info).toHaveBeenCalledWith(expect.stringContaining('No saved sessions'));
  });

  it('returns continue and emits /resume hint when sessions exist', async () => {
    mockList.mockReturnValue([
      { id: 'abc', savedAt: Date.now(), model: 'sonnet', totalTurns: 2, totalCostUsd: 0, source: 'web', name: 'my-session', cwd: '/tmp' } as ReturnType<typeof listSessions>[number],
    ]);
    const ctx = makeCtx(makeStats());
    const result = await handleWebResumeList(ctx);
    expect(result).toBe('continue');
    expect(ctx.out.info).toHaveBeenCalledWith(expect.stringContaining('/resume'));
  });
});

describe('handleWebResumeTarget', () => {
  it('returns continue with warn when session not found', async () => {
    mockFind.mockReturnValue(undefined);
    const stats = makeStats();
    const owner = makeOwner();
    const result = await handleWebResumeTarget(owner, stats.sessionId!, makeCtx(stats), 'missing');
    expect(result).toBe('continue');
    expect(makeCtx(stats).out.warn).toBeDefined();
  });

  it('returns navigate when found and create succeeds', async () => {
    const stored = makeStats({ totalTurns: 1 });
    const newId = randomUUID();
    mockFind.mockReturnValue({
      id: stored.sessionId!,
      path: '/tmp/s.json',
      data: { sessionId: stored.sessionId, model: 'sonnet', startedAt: Date.now(), savedAt: Date.now(), totalTurns: 1, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0, turns: [], source: 'web' },
    } as ReturnType<typeof findSession>);
    const owner = makeOwner(newId);
    const currentStats = makeStats({ sessionId: randomUUID() });
    const ctx = makeCtx(currentStats);
    const result = await handleWebResumeTarget(owner, currentStats.sessionId!, ctx, stored.sessionId!);
    expect(result).toEqual({ kind: 'navigate', sessionId: newId });
  });

  it('guards against resuming the live session', async () => {
    const stored = makeStats({ totalTurns: 1 });
    mockFind.mockReturnValue({
      id: stored.sessionId!,
      path: '/tmp/s.json',
      data: { sessionId: stored.sessionId, model: 'sonnet', startedAt: Date.now(), savedAt: Date.now(), totalTurns: 1, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0, turns: [], source: 'web' },
    } as ReturnType<typeof findSession>);
    const owner = makeOwner();
    const session = makeSession(stored.sessionId);
    const ctx = makeCtx(stored, session);
    const result = await handleWebResumeTarget(owner, stored.sessionId!, ctx, stored.sessionId!);
    expect(result).toBe('continue');
    expect(ctx.out.warn).toHaveBeenCalledWith(expect.stringContaining('Already on'));
    expect(owner.create).not.toHaveBeenCalled();
  });

  it('returns continue with error when create rejects', async () => {
    const stored = makeStats({ totalTurns: 1 });
    mockFind.mockReturnValue({
      id: stored.sessionId!,
      path: '/tmp/s.json',
      data: { sessionId: stored.sessionId, model: 'sonnet', startedAt: Date.now(), savedAt: Date.now(), totalTurns: 1, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0, turns: [], source: 'web' },
    } as ReturnType<typeof findSession>);
    const owner = { create: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as SessionOwner;
    const currentStats = makeStats({ sessionId: randomUUID() });
    const ctx = makeCtx(currentStats);
    const result = await handleWebResumeTarget(owner, currentStats.sessionId!, ctx, stored.sessionId!);
    expect(result).toBe('continue');
    expect(ctx.out.error).toHaveBeenCalledWith(expect.stringContaining('Failed to resume'));
  });
});

describe('handleWebFork', () => {
  it('forks the journal of the CURRENT provider conversation, not the pre-/clear id', async () => {
    const stats = makeStats({ totalTurns: 2 });
    const browserId = stats.sessionId!;
    const ctx = makeCtx(stats, makeSession('provider-after-clear'));
    mockFork.mockReturnValue({ id: 'fork-1', path: '/tmp/fork-1.json' } as never);
    await handleWebFork(makeOwner(), browserId, ctx);
    expect(vi.mocked(forkJournal)).toHaveBeenCalledWith('provider-after-clear', 'fork-1');
  });

  it('returns continue with warn when no turns', async () => {
    const stats = makeStats({ totalTurns: 0 });
    const owner = makeOwner();
    const result = await handleWebFork(owner, stats.sessionId!, makeCtx(stats));
    expect(result).toBe('continue');
    expect(owner.create).not.toHaveBeenCalled();
  });

  it('returns navigate when fork and create succeed', async () => {
    const stats = makeStats({ totalTurns: 1 });
    recordTurn(stats, 'hello', 'world', undefined, []);
    const newId = randomUUID();
    mockFork.mockReturnValue({ id: 'fork-id', path: '/tmp/fork.json' });
    const owner = makeOwner(newId);
    const ctx = makeCtx(stats);
    const result = await handleWebFork(owner, stats.sessionId!, ctx);
    expect(result).toEqual({ kind: 'navigate', sessionId: newId });
    expect(owner.create).toHaveBeenCalledOnce();
  });

  it('returns continue when create rejects after fork writes sidecar', async () => {
    const stats = makeStats({ totalTurns: 1 });
    recordTurn(stats, 'hello', 'world', undefined, []);
    mockFork.mockReturnValue({ id: 'fork-id', path: '/tmp/fork.json' });
    const owner = { create: vi.fn().mockRejectedValue(new Error('fail')) } as unknown as SessionOwner;
    const ctx = makeCtx(stats);
    const result = await handleWebFork(owner, stats.sessionId!, ctx);
    expect(result).toBe('continue');
    expect(ctx.out.error).toHaveBeenCalledWith(expect.stringContaining('Fork created but could not start'));
    expect(ctx.out.info).toHaveBeenCalledWith(expect.stringContaining('/resume'));
  });
});
