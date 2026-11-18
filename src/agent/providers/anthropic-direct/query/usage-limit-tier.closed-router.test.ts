/**
 * Integration test: closed-router rotation replay path in
 * `turnWithUsageLimitRetry`.
 *
 * Verifies that on a subscription-limit 429:
 *   1. `tryClosedRouterRotate` is called.
 *   2. When it returns `{ rotated: true }`, `adoptFreshClient` is called before
 *      the turn is replayed.
 *   3. `emitSessionPhase` is called with `phase: 'usage_limit_resume'` and
 *      `metadata.source === 'closed-router-rotate'`.
 *   4. The turn is replayed and completes successfully.
 *   5. `tryClosedRouterRotate` is called at most once per turn (once-per-turn guard).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput } from '../types.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const runTurnMock = vi.hoisted(() => vi.fn());
vi.mock('../loop.js', () => ({ runTurn: runTurnMock }));

const emitSessionPhaseMock = vi.hoisted(() => vi.fn());
vi.mock('../../../trace/emit.js', () => ({ emitSessionPhase: emitSessionPhaseMock }));

vi.mock('../../../auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: () => 'tok',
  parseAccountIdentifier: () => 'acct',
  clearKeychainCache: vi.fn(),
}));

vi.mock('../auth.js', () => ({ buildRequestHeaders: () => ({ 'x-req': 'new' }) }));

const tryClosedRouterRotateMock = vi.hoisted(() => vi.fn());
vi.mock('./closed-router-rotate.js', () => ({
  tryClosedRouterRotate: tryClosedRouterRotateMock,
}));

const adoptFreshClientMock = vi.hoisted(() => vi.fn());
vi.mock('./live-client.js', () => ({
  adoptFreshClient: adoptFreshClientMock,
  liveAccountId: () => 'acct',
}));

// catchUpStaleCredential must return false so we reach the rotation block.
const catchUpStaleCredentialMock = vi.hoisted(() => vi.fn());
vi.mock('./usage-limit-catch-up.js', () => ({
  catchUpStaleCredential: catchUpStaleCredentialMock,
  storeAheadOfClient: () => false,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import type Anthropic from '@anthropic-ai/sdk';
const { RetryLayer } = await import('./retry-layer.js');

function apiError(status: number, message: string): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

/** Usage-limit 429 with a `|<ts>` reset 30 minutes out (`oauth-limit`). */
const limit429 = (): Error =>
  apiError(429, `limit reached|${Math.floor(Date.now() / 1000) + 1800}`);

function makeLayer(): InstanceType<typeof RetryLayer> {
  return new RetryLayer({
    client: {} as unknown as Anthropic,
    authMode: 'oauth',
    initSessionId: 's1',
    autoResumeOnUsageLimit: false,
  });
}

function makeInput(): RunTurnInput {
  return {
    client: {} as never,
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

const done: ProviderEvent = {
  type: 'turn.completed',
  usage: { stopReason: 'end_turn' },
  sessionId: 's1',
};

/** Feed scripted per-attempt event arrays to runTurnMock. */
function scriptTurns(...attempts: ProviderEvent[][]): void {
  let i = 0;
  runTurnMock.mockImplementation(() => {
    const events = attempts[Math.min(i, attempts.length - 1)] ?? [];
    i++;
    return (async function* () {
      for (const e of events) yield e;
    })();
  });
}

async function drain(
  layer: InstanceType<typeof RetryLayer>,
  input = makeInput(),
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of layer.turnWithRetries(input, () => false)) out.push(e);
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('turnWithUsageLimitRetry — closed-router rotation replay', () => {
  beforeEach(() => {
    runTurnMock.mockReset();
    emitSessionPhaseMock.mockReset();
    tryClosedRouterRotateMock.mockReset();
    adoptFreshClientMock.mockReset();
    catchUpStaleCredentialMock.mockReset();
    // Default: stale-credential catch-up does nothing (not applicable here).
    catchUpStaleCredentialMock.mockResolvedValue(false);
    // Default: adoptFreshClient succeeds, returns a swapped result.
    adoptFreshClientMock.mockResolvedValue({ swapped: true, accountId: 'acct-new', oldAccountId: 'acct' });
  });

  it('calls adoptFreshClient before replay when rotation succeeds', async () => {
    tryClosedRouterRotateMock.mockResolvedValue({ rotated: true, kind: 'rotated' });
    // First attempt: 429. Second attempt (replay): success.
    scriptTurns(
      [{ type: 'error', error: limit429() }],
      [done],
    );

    const events = await drain(makeLayer());

    // adoptFreshClient must have been called (item 1 fix: rebuild the client).
    expect(adoptFreshClientMock).toHaveBeenCalledTimes(1);

    // The turn must have been replayed (runTurn called twice).
    expect(runTurnMock).toHaveBeenCalledTimes(2);

    // The done event from the replay must surface.
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
  });

  it('emits usage_limit_resume phase with source=closed-router-rotate on success', async () => {
    tryClosedRouterRotateMock.mockResolvedValue({ rotated: true, kind: 'rotated' });
    scriptTurns(
      [{ type: 'error', error: limit429() }],
      [done],
    );

    await drain(makeLayer());

    const resumeCalls = emitSessionPhaseMock.mock.calls.filter(
      (c) => (c[1] as { phase?: string }).phase === 'usage_limit_resume',
    );
    expect(resumeCalls.length).toBeGreaterThanOrEqual(1);
    const meta = (resumeCalls[0]?.[1] as { metadata?: { source?: string } }).metadata;
    expect(meta?.source).toBe('closed-router-rotate');
  });

  it('calls tryClosedRouterRotate at most once per turn (once-per-turn guard)', async () => {
    // rotation succeeds but adoptFreshClient fails → falls through to park,
    // which eventually surfaces the error. The rotation must NOT be retried.
    tryClosedRouterRotateMock.mockResolvedValue({ rotated: true, kind: 'rotated' });
    adoptFreshClientMock.mockResolvedValue(null); // adoption failure
    scriptTurns([{ type: 'error', error: limit429() }]);

    await drain(makeLayer());

    expect(tryClosedRouterRotateMock).toHaveBeenCalledTimes(1);
  });

  it('falls through to park when rotation returns rotated:false', async () => {
    tryClosedRouterRotateMock.mockResolvedValue({ rotated: false, kind: 'all-hot' });
    scriptTurns([{ type: 'error', error: limit429() }]);

    const events = await drain(makeLayer());

    // adoptFreshClient must NOT be called (rotation did not succeed).
    expect(adoptFreshClientMock).not.toHaveBeenCalled();
    // The error should surface (paused path or error).
    expect(events.some((e) => e.type === 'paused' || e.type === 'error')).toBe(true);
  });
});
