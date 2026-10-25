import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findSession: vi.fn(),
  readLivePresenceFiles: vi.fn(),
  stats: new Map<string, Record<string, unknown>>(),
}));
vi.mock('./session-owner.slash.js', () => ({ getStats: (id: string) => mocks.stats.get(id) }));
vi.mock('../cli/session-store.js', () => ({
  findSession: mocks.findSession,
  forkStoredSession: vi.fn(),
  listSessions: vi.fn(() => []),
  saveSession: vi.fn(),
}));
vi.mock('../agent/awareness/presence.js', () => ({ readLivePresenceFiles: mocks.readLivePresenceFiles }));
vi.mock('../cli/resume-session.js', () => ({ resumeConfigFor: vi.fn(() => ({ resume: 'x' })) }));

import { resumeStoredSessionById, isLiveElsewhere } from './session-owner.lifecycle.js';
import type { SessionOwner } from './session-owner.js';

const stored = { id: 'side-1', data: { sessionId: 'prov-1', model: 'haiku', cwd: '/w', totalTurns: 4, totalCostUsd: 0.12, totalTokens: 900, totalDurationMs: 5000, turns: [{ input: 'hi' }], name: 'old-chat', startedAt: 1000 } };
const owner = () => ({ create: vi.fn(async () => ({ id: 'prov-1' })) }) as unknown as SessionOwner & { create: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stats.clear();
  mocks.findSession.mockReturnValue(stored);
});

describe('resumeStoredSessionById', () => {
  it('resumes an ended session', async () => {
    mocks.readLivePresenceFiles.mockResolvedValue([{ sessionId: 'someone-else' }]);
    const o = owner();
    expect(await resumeStoredSessionById(o, 'side-1')).toEqual({ kind: 'resumed', id: 'prov-1' });
    expect(o.create).toHaveBeenCalledOnce();
  });

  it('carries the stored turns, cost and name into the new session (so /cost and /fork work)', async () => {
    mocks.readLivePresenceFiles.mockResolvedValue([]);
    const live = { totalTurns: 0, totalCostUsd: 0, turns: [] as unknown[] };
    mocks.stats.set('prov-1', live);
    await resumeStoredSessionById(owner(), 'side-1');
    expect(live).toMatchObject({ totalTurns: 4, totalCostUsd: 0.12, name: 'old-chat' });
    expect(live.turns).toHaveLength(1);
  });

  it('refuses a session live in another process, without creating anything', async () => {
    mocks.readLivePresenceFiles.mockResolvedValue([{ sessionId: 'prov-1' }]);
    const o = owner();
    expect(await resumeStoredSessionById(o, 'side-1')).toEqual({ kind: 'live-elsewhere' });
    expect(o.create).not.toHaveBeenCalled();
  });

  it('reports not-found', async () => {
    mocks.findSession.mockReturnValue(undefined);
    expect(await resumeStoredSessionById(owner(), 'nope')).toEqual({ kind: 'not-found' });
  });
});

describe('isLiveElsewhere', () => {
  it('matches on the sidecar id as well as the provider id', async () => {
    mocks.readLivePresenceFiles.mockResolvedValue([{ sessionId: 'side-1' }]);
    expect(await isLiveElsewhere(stored as never)).toBe(true);
  });

  it('fails closed when presence cannot be read', async () => {
    mocks.readLivePresenceFiles.mockRejectedValue(new Error('EACCES'));
    expect(await isLiveElsewhere(stored as never)).toBe(true);
  });
});
