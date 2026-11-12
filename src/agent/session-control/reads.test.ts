import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStats } from '../../cli/slash/session-stats.js';
import type { AgentSession } from '../session.js';
import { readContextUsage, readTokenUsage, readLocalTokenUsage, readMcpStatus, readMcpOauthPending } from './index.js';

const { pending } = vi.hoisted(() => ({ pending: vi.fn() }));
vi.mock('../mcp/oauth.js', () => ({ readOauthPending: pending }));

beforeEach(() => { pending.mockReset(); });

describe('session-control reads', () => {
  it('returns exact provider context breakdown and keeps read errors observable', async () => {
    const usage = { totalTokens: 120, maxTokens: 1000, percentage: 12 };
    const getContextUsage = vi.fn().mockResolvedValue(usage);
    expect(await readContextUsage({ getContextUsage })).toBe(usage);
    const stats = createSessionStats('sonnet');
    expect(await readTokenUsage({ getContextUsage }, stats)).toEqual({ kind: 'sdk', usage });
    await expect(readContextUsage({ getContextUsage: vi.fn().mockRejectedValue(new Error('offline')) })).rejects.toThrow('offline');
  });

  it('falls back locally on provider failure, using last footprint rather than cumulative cache', async () => {
    const stats = createSessionStats('sonnet');
    stats.turnTokens = [
      { input: 100, output: 20, cache: 5000, footprint: 150 },
      { input: 200, output: 30, cache: 6000, footprint: 250 },
    ];
    const before = structuredClone(stats);
    const local = await readTokenUsage({ getContextUsage: vi.fn().mockRejectedValue(new Error('not initialized')) }, stats);
    expect(local).toMatchObject({ kind: 'local', input: 300, output: 50, cache: 11000, total: 350, contextUsed: 250, model: 'sonnet' });
    expect(local.kind === 'local' && local.percentage).toBe(Math.round(250 / (local.kind === 'local' ? local.contextLimit : 1) * 100));
    expect(stats).toEqual(before);
  });

  it('supports old records without footprint and empty sessions', () => {
    const stats = createSessionStats('sonnet');
    expect(readLocalTokenUsage(stats)).toMatchObject({ input: 0, output: 0, cache: 0, total: 0, contextUsed: 0, percentage: 0 });
    stats.turnTokens = [{ input: 10, output: 20, cache: 30 }];
    expect(readLocalTokenUsage(stats)).toMatchObject({ contextUsed: 60, total: 30 });
  });

  it('waits for initialization before reading MCP status and handles no servers', async () => {
    const servers = [{ name: 'server', status: 'connected' }];
    const session = { waitForInitialization: vi.fn().mockResolvedValueOnce({ mcpServers: servers }).mockResolvedValueOnce({}) };
    expect(await readMcpStatus(session as unknown as AgentSession)).toBe(servers);
    expect(await readMcpStatus(session as unknown as AgentSession)).toEqual([]);
    expect(session.waitForInitialization).toHaveBeenCalledTimes(2);
    session.waitForInitialization.mockRejectedValue(new Error('init'));
    await expect(readMcpStatus(session as unknown as AgentSession)).rejects.toThrow('init');
  });

  it('reads pending OAuth from the existing state reader without mutation', async () => {
    const state = { server: { authorizationUrl: 'https://example.com/oauth', timestamp: 100 } };
    pending.mockReturnValue(state);
    expect(await readMcpOauthPending()).toBe(state);
    expect(pending).toHaveBeenCalledOnce();
  });
});
