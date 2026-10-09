/**
 * live-client: the single refresh-then-adopt step every replay site uses, and
 * the account name taken from the live client rather than the store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunTurnInput } from '../types.js';

const loadClaudeCodeOauthTokenMock = vi.hoisted(() => vi.fn<[], string | undefined>());

vi.mock('../../../auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: loadClaudeCodeOauthTokenMock,
  parseAccountIdentifier: (t: string) => (t ? `acct:${t}` : 'token:(unknown)'),
}));

const { adoptFreshClient, liveAccountId } = await import('./live-client.js');

function makeInput(): RunTurnInput {
  return {
    client: { id: 'old' } as never,
    messages: [],
    system: null,
    tools: null,
    toolDispatcher: {} as never,
    model: 'claude-test',
    maxTokens: 1,
    headers: { 'x-request-id': 'old' },
    signal: new AbortController().signal,
    ctx: { sessionId: 's1' } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('adoptFreshClient', () => {
  it('awaits refresh before adoption and rotates after adopting', async () => {
    const result = { accountId: 'acct:b', oldAccountId: 'acct:a', swapped: true };
    let resolve!: (value: typeof result) => void;
    const fresh = { id: 'new' } as never;
    const input = makeInput();
    const getClient = vi.fn(() => fresh);
    const rotateHeaders = vi.fn((adopted: RunTurnInput) => {
      expect(adopted.client).toBe(fresh);
      return { 'x-request-id': 'new' };
    });
    const ctx = { forceClientRefresh: () => new Promise<typeof result>((r) => { resolve = r; }), getClient, rotateHeaders };
    const pending = adoptFreshClient(ctx, input);
    expect(getClient).not.toHaveBeenCalled();
    expect(rotateHeaders).not.toHaveBeenCalled();
    expect(input.client).toEqual({ id: 'old' });
    resolve(result);
    await expect(pending).resolves.toBe(result);
    expect(rotateHeaders).toHaveBeenCalledTimes(1);
  });

  it('propagates refresh rejection without changing replay state', async () => {
    const failure = new Error('refresh failed');
    const input = makeInput();
    const client = input.client;
    const headers = input.headers;
    const ctx = { forceClientRefresh: vi.fn().mockRejectedValue(failure), getClient: vi.fn(), rotateHeaders: vi.fn() };
    await expect(adoptFreshClient(ctx, input)).rejects.toBe(failure);
    expect(input.client).toBe(client);
    expect(input.headers).toBe(headers);
    expect(ctx.getClient).not.toHaveBeenCalled();
    expect(ctx.rotateHeaders).not.toHaveBeenCalled();
  });

  it('points the replay at the REBUILT client with fresh headers', async () => {
    const result = { accountId: 'acct:b', oldAccountId: 'acct:a', swapped: true };
    const ctx = {
      forceClientRefresh: vi.fn().mockResolvedValue(result),
      getClient: () => ({ id: 'new' }) as never,
      rotateHeaders: () => ({ 'x-request-id': 'new' }),
    };
    const input = makeInput();
    await expect(adoptFreshClient(ctx, input)).resolves.toBe(result);
    expect(input.client).toEqual({ id: 'new' });
    expect(input.headers).toEqual({ 'x-request-id': 'new' });
  });

  it('leaves the replay untouched when the refresh fails', async () => {
    const getClient = vi.fn();
    const rotateHeaders = vi.fn();
    const ctx = { forceClientRefresh: vi.fn().mockResolvedValue(null), getClient, rotateHeaders };
    const input = makeInput();
    await expect(adoptFreshClient(ctx, input)).resolves.toBeNull();
    expect(input.client).toEqual({ id: 'old' });
    expect(input.headers).toEqual({ 'x-request-id': 'old' });
    expect(getClient).not.toHaveBeenCalled();
    expect(rotateHeaders).not.toHaveBeenCalled();
  });
});

describe('liveAccountId', () => {
  it('names the client token account even when the store has moved on', () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    expect(liveAccountId({ getClientToken: () => 'tok-a' })).toBe('acct:tok-a');
    expect(loadClaudeCodeOauthTokenMock).not.toHaveBeenCalled();
  });

  it('falls back to the store when the client token is unknown', () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    expect(liveAccountId({ getClientToken: () => undefined })).toBe('acct:tok-b');
  });

  it('returns the unknown sentinel when neither is available', () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue(undefined);
    expect(liveAccountId({ getClientToken: () => undefined })).toBe('token:(unknown)');
  });
});
