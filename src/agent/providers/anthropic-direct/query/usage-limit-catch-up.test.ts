/**
 * Stale-credential catch-up: an account switch that landed BEFORE the 429
 * must be picked up without `/reauth` (operator report 2026-10-08: "when I
 * switch accounts I have to run /reauth and send a message").
 *
 * Coverage:
 *  - catchUpStaleCredential unit contract (each `false` branch + the swap)
 *  - turnWithUsageLimitRetry: store != client token → replays on the new
 *    client with NO `paused` event; bounded to one catch-up per turn
 *  - store == client token → parks exactly as before (catch-up is a no-op)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderEvent } from '../../../provider.js';
import type { RetryTierContext, TierGenerator } from './retry-context.js';
import type { RunTurnInput } from '../types.js';

const loadClaudeCodeOauthTokenMock = vi.hoisted(() => vi.fn<[], string | undefined>());
const emitSessionPhaseMock = vi.hoisted(() => vi.fn());
const usageLimitResetPauseMock = vi.hoisted(() => vi.fn());

vi.mock('../../../auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: loadClaudeCodeOauthTokenMock,
  parseAccountIdentifier: (t: string) => `acct:${t}`,
}));
vi.mock('../../../trace/emit.js', () => ({ emitSessionPhase: emitSessionPhaseMock }));
vi.mock('../usage-limit.js', () => ({
  classifyUsageLimitError: (err: Error) =>
    err.message === 'limited'
      ? { kind: 'oauth-limit', resetsAt: new Date(Date.now() + 3 * 24 * 3600_000) }
      : null,
}));
vi.mock('./usage-limit-pause.js', () => ({
  usageLimitNoTimestampPause: vi.fn(),
  usageLimitResetPause: usageLimitResetPauseMock,
}));

const { catchUpStaleCredential } = await import('./usage-limit-catch-up.js');
const { turnWithUsageLimitRetry } = await import('./usage-limit-tier.js');

const done: ProviderEvent = { type: 'turn.completed', usage: { stopReason: 'end_turn' }, sessionId: 's1' };
const limited: ProviderEvent = { type: 'error', error: new Error('limited') };

interface FakeCtx extends RetryTierContext {
  _clientToken: string | undefined;
  _client: object;
  _refresh: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: { clientToken: string | undefined; authMode?: 'oauth' | 'api-key'; refreshOk?: boolean }): FakeCtx {
  const ctx = {
    authMode: opts.authMode ?? 'oauth',
    surface: 'repl',
    autoResumeOnUsageLimit: true,
    tokenRefresher: undefined,
    _clientToken: opts.clientToken,
    _client: { id: 'client-a' },
    getClient: () => ctx._client as never,
    getClientToken: () => ctx._clientToken,
    rotateHeaders: () => ({ 'x-rotated': '1' }),
    getUsageLimitWait: () => null,
    setUsageLimitWait: () => {},
    markCredentialSnapshotStale: vi.fn(),
  } as unknown as FakeCtx;
  ctx._refresh = vi.fn(async () => {
    if (opts.refreshOk === false) return null;
    const prior = ctx._clientToken;
    const next = loadClaudeCodeOauthTokenMock();
    ctx._client = { id: `client-${next}` };
    ctx._clientToken = next;
    return { accountId: `acct:${next}`, oldAccountId: `acct:${prior}`, swapped: prior !== next };
  });
  (ctx as { forceClientRefresh: unknown }).forceClientRefresh = ctx._refresh;
  return ctx;
}

function makeInput(): RunTurnInput {
  return {
    client: { id: 'client-a' } as never,
    messages: [{ role: 'user', content: 'hi' }],
    system: null,
    tools: null,
    toolDispatcher: {} as never,
    model: 'claude-test',
    maxTokens: 1024,
    headers: {},
    signal: new AbortController().signal,
    ctx: { sessionId: 's1' } as never,
  };
}

async function drain(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  emitSessionPhaseMock.mockResolvedValue(undefined);
  usageLimitResetPauseMock.mockImplementation(async function* () {
    yield { type: 'paused', reason: 'usage-limit', autoResume: true, provider: 'anthropic' };
  });
});

describe('catchUpStaleCredential', () => {
  it('swaps the client and rotates headers when the store holds a newer token', async () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    const ctx = makeCtx({ clientToken: 'tok-a' });
    const input = makeInput();
    await expect(catchUpStaleCredential(ctx, input)).resolves.toBe(true);
    expect(ctx._refresh).toHaveBeenCalledTimes(1);
    expect(input.client).toEqual({ id: 'client-tok-b' });
    expect(input.headers).toEqual({ 'x-rotated': '1' });
    expect(emitSessionPhaseMock).toHaveBeenCalledWith(undefined, expect.objectContaining({
      phase: 'usage_limit_resume',
      metadata: expect.objectContaining({ source: 'credential-catch-up', hotSwapped: true }),
    }));
  });

  it('is a no-op when the store matches the client token', async () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-a');
    const ctx = makeCtx({ clientToken: 'tok-a' });
    await expect(catchUpStaleCredential(ctx, makeInput())).resolves.toBe(false);
    expect(ctx._refresh).not.toHaveBeenCalled();
  });

  it('never treats an unreadable store as a swap target', async () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue(undefined);
    const ctx = makeCtx({ clientToken: 'tok-a' });
    await expect(catchUpStaleCredential(ctx, makeInput())).resolves.toBe(false);
    expect(ctx._refresh).not.toHaveBeenCalled();
  });

  it('is a no-op in api-key mode', async () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    const ctx = makeCtx({ clientToken: 'tok-a', authMode: 'api-key' });
    await expect(catchUpStaleCredential(ctx, makeInput())).resolves.toBe(false);
    expect(ctx._refresh).not.toHaveBeenCalled();
  });

  it('returns false and keeps the old client when the refresh fails', async () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    const ctx = makeCtx({ clientToken: 'tok-a', refreshOk: false });
    const input = makeInput();
    await expect(catchUpStaleCredential(ctx, input)).resolves.toBe(false);
    expect(input.client).toEqual({ id: 'client-a' });
  });
});

describe('turnWithUsageLimitRetry — account switched before the 429', () => {
  it('replays on the new account without parking (no /reauth needed)', async () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    const ctx = makeCtx({ clientToken: 'tok-a' });
    const seenClients: unknown[] = [];
    const next: TierGenerator = async function* (_c, input) {
      seenClients.push(input.client);
      if (seenClients.length === 1) { yield limited; return; }
      yield done;
    };
    const events = await drain(turnWithUsageLimitRetry(ctx, makeInput(), () => false, next));
    expect(events).toEqual([done]);
    expect(events.some((e) => e.type === 'paused')).toBe(false);
    expect(seenClients).toEqual([{ id: 'client-a' }, { id: 'client-tok-b' }]);
    expect(usageLimitResetPauseMock).not.toHaveBeenCalled();
  });

  it('falls through to the normal park when the replay re-limits (one catch-up per turn)', async () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    const ctx = makeCtx({ clientToken: 'tok-a' });
    let calls = 0;
    const next: TierGenerator = async function* () { calls++; yield limited; };
    const events = await drain(turnWithUsageLimitRetry(ctx, makeInput(), () => false, next));
    expect(calls).toBe(2);
    expect(ctx._refresh).toHaveBeenCalledTimes(1);
    expect(usageLimitResetPauseMock).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toEqual(['paused']);
  });

  it('parks exactly as before when the client already holds the store token', async () => {
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-a');
    const ctx = makeCtx({ clientToken: 'tok-a' });
    let calls = 0;
    const next: TierGenerator = async function* () { calls++; yield limited; };
    await drain(turnWithUsageLimitRetry(ctx, makeInput(), () => false, next));
    expect(calls).toBe(1);
    expect(ctx._refresh).not.toHaveBeenCalled();
    expect(usageLimitResetPauseMock).toHaveBeenCalledTimes(1);
  });
});
