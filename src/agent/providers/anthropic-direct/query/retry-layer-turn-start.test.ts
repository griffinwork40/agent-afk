/**
 * Turn-start credential catch-up in {@link RetryLayer.turnWithRetries}.
 *
 * Operator question 2026-10-21: "why is /reauth not automatic?" An account
 * switch (`claude login` in another terminal) with NO error left the running
 * session on the old account until a 401, a usage-limit 429, or a manual
 * `/reauth`, and Telegram / the web UI have no `/reauth` at all. The layer
 * now compares the store with the live client token at the top of every turn.
 *
 * Coverage:
 *  - store moved between turns → client rebuilt BEFORE the turn runs, and
 *    the turn runs on the new client; a `credential_swap` phase is emitted
 *  - store unchanged → no refresh, no trace
 *  - CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY pin the credential → no swap
 *  - aborted signal → no refresh
 *  - syncClientWithStore (compaction path) swaps only when the store moved
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput } from '../types.js';

const loadClaudeCodeOauthTokenMock = vi.hoisted(() => vi.fn<(opts?: { quiet?: boolean }) => string | undefined>());
const emitSessionPhaseMock = vi.hoisted(() => vi.fn());
const seenClients = vi.hoisted(() => [] as unknown[]);

vi.mock('../../../auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: loadClaudeCodeOauthTokenMock,
  parseAccountIdentifier: (t: string) => `acct:${t}`,
}));
vi.mock('../../../auth/credential-resolver.js', () => ({
  setRefreshedClaudeCodeOauthToken: vi.fn(),
}));
vi.mock('../../../trace/emit.js', () => ({ emitSessionPhase: emitSessionPhaseMock }));
vi.mock('../auth.js', () => ({ buildRequestHeaders: () => ({ 'x-rotated': '1' }) }));
vi.mock('../cache-policy.js', () => ({ isExtendedCacheTtlActive: () => false }));
// Stand-in for the whole tier stack: record which client the turn ran on.
vi.mock('./overload-pause-tier.js', () => ({
  turnWithOverloadPause: async function* (_ctx: unknown, input: RunTurnInput) {
    seenClients.push(input.client);
    yield { type: 'turn.completed', usage: { stopReason: 'end_turn' }, sessionId: 's1' } as ProviderEvent;
  },
}));

const { RetryLayer } = await import('./retry-layer.js');

function client(id: string): Anthropic {
  return { id } as unknown as Anthropic;
}

function makeLayer(clientToken: string) {
  loadClaudeCodeOauthTokenMock.mockReturnValueOnce(clientToken); // constructor snapshot
  const refresher = vi.fn(async () => client(`client-${loadClaudeCodeOauthTokenMock() ?? 'none'}`));
  const layer = new RetryLayer({
    client: client(`client-${clientToken}`),
    authMode: 'oauth',
    initSessionId: 's1',
    autoResumeOnUsageLimit: true,
    tokenRefresher: refresher,
  });
  return { layer, refresher };
}

function makeInput(layer: InstanceType<typeof RetryLayer>, signal = new AbortController().signal): RunTurnInput {
  return {
    client: layer.client as never,
    messages: [{ role: 'user', content: 'hi' }],
    system: null,
    tools: null,
    toolDispatcher: {} as never,
    model: 'claude-test',
    maxTokens: 1024,
    headers: {},
    signal,
    ctx: { sessionId: 's1' } as never,
  };
}

async function drain(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  loadClaudeCodeOauthTokenMock.mockReset();
  emitSessionPhaseMock.mockReset();
  emitSessionPhaseMock.mockResolvedValue(undefined);
  seenClients.length = 0;
  // Hermetic: a developer shell may export either var, which would disable
  // the catch-up these tests exercise.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RetryLayer.turnWithRetries — turn-start credential catch-up', () => {
  it('adopts an account switch made between turns before the turn runs', async () => {
    const { layer, refresher } = makeLayer('tok-a');
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b'); // `claude login` ran

    await drain(layer.turnWithRetries(makeInput(layer), () => false));

    expect(refresher).toHaveBeenCalledTimes(1);
    expect(seenClients).toEqual([{ id: 'client-tok-b' }]);
    expect(layer.client).toEqual({ id: 'client-tok-b' });
    expect(loadClaudeCodeOauthTokenMock).toHaveBeenCalledWith({ quiet: true, background: true });
    expect(emitSessionPhaseMock).toHaveBeenCalledWith(undefined, expect.objectContaining({
      phase: 'credential_swap',
      metadata: expect.objectContaining({ source: 'turn-start', accountId: 'acct:tok-b', oldAccountId: 'acct:tok-a' }),
    }));
  });

  it('does nothing when the store still matches the live client', async () => {
    const { layer, refresher } = makeLayer('tok-a');
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-a');

    await drain(layer.turnWithRetries(makeInput(layer), () => false));

    expect(refresher).not.toHaveBeenCalled();
    expect(seenClients).toEqual([{ id: 'client-tok-a' }]);
    expect(emitSessionPhaseMock).not.toHaveBeenCalled();
  });

  it.each(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'])(
    'never moves a session whose credential is pinned by %s',
    async (name) => {
      vi.stubEnv(name, 'pinned-credential');
      const { layer, refresher } = makeLayer('tok-a');
      loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');

      await drain(layer.turnWithRetries(makeInput(layer), () => false));

      expect(refresher).not.toHaveBeenCalled();
      expect(seenClients).toEqual([{ id: 'client-tok-a' }]);
    },
  );

  it('skips the check when the turn is already aborted', async () => {
    const { layer, refresher } = makeLayer('tok-a');
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    const ac = new AbortController();
    ac.abort();

    await drain(layer.turnWithRetries(makeInput(layer, ac.signal), () => false));

    expect(refresher).not.toHaveBeenCalled();
  });
});

describe('RetryLayer — credentialFromStore: true + env var set (defence-in-depth)', () => {
  it('never swaps when credentialFromStore is true but ANTHROPIC_API_KEY pins the credential', async () => {
    // Defence-in-depth: even when credentialFromStore is explicitly true, the
    // env-var guard in storeAheadOfClient must still block the swap. This path
    // covers the case where the flag was set optimistically but an env var
    // (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) is also present — the env
    // var takes precedence so the session must not be silently moved.
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-pinned-key');

    loadClaudeCodeOauthTokenMock.mockReturnValueOnce('store-tok'); // constructor snapshot
    const refresher = vi.fn(async () => client('client-new'));
    const layer = new RetryLayer({
      client: client('client-store-tok'),
      authMode: 'oauth',
      initSessionId: 's1',
      autoResumeOnUsageLimit: true,
      tokenRefresher: refresher,
      credentialFromStore: true,
    });
    // Store has moved to a different token — but env var pins the credential.
    loadClaudeCodeOauthTokenMock.mockReturnValue('store-tok-new');

    await drain(layer.turnWithRetries(makeInput(layer), () => false));

    expect(refresher).not.toHaveBeenCalled();
    expect(emitSessionPhaseMock).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ phase: 'credential_swap' }),
    );
  });

  it('never swaps when credentialFromStore is true but CLAUDE_CODE_OAUTH_TOKEN pins the credential', async () => {
    // Parallel case for CLAUDE_CODE_OAUTH_TOKEN: the env-var guard in
    // storeAheadOfClient covers both vars, so the same block applies when
    // CLAUDE_CODE_OAUTH_TOKEN is set instead of ANTHROPIC_API_KEY.
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'env-oauth-pinned');

    loadClaudeCodeOauthTokenMock.mockReturnValueOnce('store-tok'); // constructor snapshot
    const refresher = vi.fn(async () => client('client-new'));
    const layer = new RetryLayer({
      client: client('client-store-tok'),
      authMode: 'oauth',
      initSessionId: 's1',
      autoResumeOnUsageLimit: true,
      tokenRefresher: refresher,
      credentialFromStore: true,
    });
    // Store has moved to a different token — but env var pins the credential.
    loadClaudeCodeOauthTokenMock.mockReturnValue('store-tok-new');

    await drain(layer.turnWithRetries(makeInput(layer), () => false));

    expect(refresher).not.toHaveBeenCalled();
    expect(emitSessionPhaseMock).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ phase: 'credential_swap' }),
    );
  });

  it('swaps when credentialFromStore is true and no env var is set', async () => {
    // Positive path: credentialFromStore true, no env-var pin, store moved —
    // the swap must proceed (mirrors the base turn-start test but with the
    // explicit provenance flag set).
    loadClaudeCodeOauthTokenMock.mockReturnValueOnce('tok-a'); // constructor snapshot
    const refresher = vi.fn(async () => client(`client-${loadClaudeCodeOauthTokenMock() ?? 'none'}`));
    const layer = new RetryLayer({
      client: client('client-tok-a'),
      authMode: 'oauth',
      initSessionId: 's1',
      autoResumeOnUsageLimit: true,
      tokenRefresher: refresher,
      credentialFromStore: true,
    });
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b'); // store moved

    await drain(layer.turnWithRetries(makeInput(layer), () => false));

    expect(refresher).toHaveBeenCalledTimes(1);
    expect(emitSessionPhaseMock).toHaveBeenCalledWith(undefined, expect.objectContaining({
      phase: 'credential_swap',
      metadata: expect.objectContaining({ source: 'turn-start' }),
    }));
  });
});

describe('RetryLayer — credentialFromStore: false (explicit non-store credential)', () => {
  it('never swaps a session whose credential was NOT sourced from the store', async () => {
    // Simulate a slot-pinned OAuth key (AFK_MODEL_<TIER>_API_KEY set to an
    // OAuth token): authMode is 'oauth' but credentialFromStore is false.
    loadClaudeCodeOauthTokenMock.mockReturnValueOnce('slot-tok'); // constructor snapshot
    const refresher = vi.fn(async () => client('client-new'));
    const layer = new RetryLayer({
      client: client('client-slot-tok'),
      authMode: 'oauth',
      initSessionId: 's1',
      autoResumeOnUsageLimit: true,
      tokenRefresher: refresher,
      credentialFromStore: false,
    });
    // Store has a different token — but credential is pinned, so no swap.
    loadClaudeCodeOauthTokenMock.mockReturnValue('store-tok');

    await drain(layer.turnWithRetries(makeInput(layer), () => false));

    expect(refresher).not.toHaveBeenCalled();
    expect(emitSessionPhaseMock).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ phase: 'credential_swap' }),
    );
  });
});

describe('RetryLayer.syncClientWithStore — compaction path', () => {
  it('rebuilds the client when the store moved ahead of it', async () => {
    const { layer, refresher } = makeLayer('tok-a');
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');

    const result = await layer.syncClientWithStore();

    expect(refresher).toHaveBeenCalledTimes(1);
    expect(layer.client).toEqual({ id: 'client-tok-b' });
    expect(result).toMatchObject({ swapped: true });
  });

  it('is a no-op when the store matches', async () => {
    const { layer, refresher } = makeLayer('tok-a');
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-a');

    const result = await layer.syncClientWithStore();

    expect(refresher).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
