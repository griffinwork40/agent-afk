/**
 * `model.fallback_request` from the Anthropic usage-limit tier (`models.fallback`).
 *
 * Drives the full tier composition (overload pause → usage limit → auth) via
 * `RetryLayer.turnWithRetries` with `runTurn` mocked, so progress tracking is
 * exercised across overload probes exactly as production composes it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput } from '../types.js';

const runTurnMock = vi.hoisted(() => vi.fn());
const emitSessionPhaseMock = vi.hoisted(() => vi.fn());
vi.mock('../loop.js', () => ({ runTurn: runTurnMock }));
vi.mock('../../../auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: () => 'tok',
  parseAccountIdentifier: () => 'acct',
}));
vi.mock('../auth.js', () => ({ buildRequestHeaders: () => ({ 'x-req': 'new' }) }));
vi.mock('../../../trace/emit.js', () => ({ emitSessionPhase: emitSessionPhaseMock }));

const { RetryLayer } = await import('./retry-layer.js');
const { OVERLOAD_EXHAUSTED } = await import('../overload-pause.js');

const done: ProviderEvent = { type: 'turn.completed', usage: { stopReason: 'end_turn' }, sessionId: 's1' };
const exhausted: ProviderEvent = { type: 'turn.completed', usage: { stopReason: OVERLOAD_EXHAUSTED }, sessionId: 's1' };

function apiError(status: number, message: string, body?: { type: string; message: string }): Error {
  const e = new Error(message) as Error & { status: number; error?: unknown };
  e.status = status;
  if (body) e.error = { type: 'error', error: body };
  return e;
}
/** Usage-limit 429 with a `|<ts>` reset 30 minutes out (`oauth-limit`). */
const limit429 = (): Error => apiError(429, `limit reached|${Math.floor(Date.now() / 1000) + 1800}`);
const creditError = (): Error =>
  apiError(400, '400 {"type":"invalid_request_error","message":"Your credit balance is too low"}');
const modelNotFound = (): Error =>
  apiError(404, 'model: claude-test', { type: 'not_found_error', message: 'model: claude-test' });
const promptTooLong = (): Error =>
  apiError(400, 'prompt is too long', { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens' });

function makeLayer(opts: { armed?: boolean | (() => boolean); autoResume?: boolean; surface?: string } = {}) {
  return new RetryLayer({
    client: {} as unknown as Anthropic,
    authMode: 'api-key',
    initSessionId: 's1',
    autoResumeOnUsageLimit: opts.autoResume ?? true,
    ...(opts.armed !== undefined ? { modelFallbackArmed: opts.armed } : {}),
    ...(opts.surface !== undefined ? { surface: opts.surface } : {}),
  });
}

function makeInput(signal: AbortSignal = new AbortController().signal): RunTurnInput {
  return {
    client: {} as never,
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

/** Feed scripted per-attempt event arrays to the mocked runTurn. */
function scriptTurns(...attempts: Array<Array<ProviderEvent | (() => ProviderEvent)>>): void {
  let i = 0;
  runTurnMock.mockImplementation(() => {
    const events = attempts[Math.min(i, attempts.length - 1)] ?? [];
    i++;
    return (async function* () {
      for (const e of events) yield typeof e === 'function' ? e() : e;
    })();
  });
}

async function drain(layer: InstanceType<typeof RetryLayer>, input = makeInput()): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of layer.turnWithRetries(input, () => false)) out.push(e);
  return out;
}

const types = (events: ProviderEvent[]): string[] => events.map((e) => e.type);
const fallbackRequests = (events: ProviderEvent[]) =>
  events.filter((e): e is Extract<ProviderEvent, { type: 'model.fallback_request' }> => e.type === 'model.fallback_request');
const pausePhases = () =>
  emitSessionPhaseMock.mock.calls.filter((c) => (c[1] as { phase?: string }).phase === 'usage_limit_pause');

beforeEach(() => {
  runTurnMock.mockReset();
  emitSessionPhaseMock.mockReset();
  delete process.env['AFK_OVERLOAD_PAUSE_MS'];
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env['AFK_OVERLOAD_PAUSE_MS'];
});

describe('usage-limit tier model fallback: usage-limit 429', () => {
  it('a. armed + no progress: one request carrying the original error, no paused/error, ends', async () => {
    const err = limit429();
    scriptTurns([{ type: 'error', error: err }]);
    const events = await drain(makeLayer({ armed: true }));
    expect(types(events)).toEqual(['model.fallback_request']);
    const [req] = fallbackRequests(events);
    expect(req?.reason).toBe('usage-limit');
    expect(req?.error).toBe(err);
    expect(req?.sessionId).toBe('s1');
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(pausePhases()).toHaveLength(0);
  });

  it('b. armed + earlier progress: parks as today, no request', async () => {
    scriptTurns([{ type: 'delta.text', text: 'partial', sessionId: 's1' }, { type: 'error', error: limit429() }]);
    const events = await drain(makeLayer({ armed: true, autoResume: false }));
    expect(types(events)).toEqual(['delta.text', 'paused', 'error']);
    expect(pausePhases()).toHaveLength(1);
  });

  it('c. not armed: unchanged (paused then error on a fail-fast surface)', async () => {
    scriptTurns([{ type: 'error', error: limit429() }]);
    for (const armed of [undefined, false, () => false]) {
      emitSessionPhaseMock.mockReset();
      const layer = makeLayer({ autoResume: false, ...(armed !== undefined ? { armed } : {}) });
      expect(types(await drain(layer))).toEqual(['paused', 'error']);
      expect(pausePhases()).toHaveLength(1);
    }
  });

  it('f. rate_limit / stream.retry before the 429 do not count as progress', async () => {
    scriptTurns([
      { type: 'rate_limit', sessionId: 's1', status: 429 },
      { type: 'stream.retry', sessionId: 's1' },
      { type: 'error', error: limit429() },
    ]);
    const events = await drain(makeLayer({ armed: true }));
    expect(types(events)).toEqual(['rate_limit', 'stream.retry', 'model.fallback_request']);
  });

  it('h. the armed predicate is read live at decision time', async () => {
    let armed = true;
    const predicate = vi.fn(() => armed);
    scriptTurns([
      () => {
        armed = false;
        return { type: 'rate_limit', sessionId: 's1' };
      },
      { type: 'error', error: limit429() },
    ]);
    const events = await drain(makeLayer({ armed: predicate, autoResume: false }));
    expect(fallbackRequests(events)).toHaveLength(0);
    expect(types(events)).toEqual(['rate_limit', 'paused', 'error']);
    expect(predicate).toHaveBeenCalled();
  });

  it('i. autoResumeOnUsageLimit=false + armed + no progress: request, not fail-fast', async () => {
    scriptTurns([{ type: 'error', error: limit429() }]);
    const events = await drain(makeLayer({ armed: true, autoResume: false }));
    expect(types(events)).toEqual(['model.fallback_request']);
  });
});

describe('usage-limit tier model fallback: credit and model rejection', () => {
  it('d. armed + credit-exhausted 400: one request, reason credit-exhausted, ends', async () => {
    const err = creditError();
    scriptTurns([{ type: 'error', error: err }, done]);
    const events = await drain(makeLayer({ armed: true }));
    expect(types(events)).toEqual(['model.fallback_request']);
    expect(fallbackRequests(events)[0]?.reason).toBe('credit-exhausted');
    expect(fallbackRequests(events)[0]?.error).toBe(err);
  });

  it('d. not armed + credit-exhausted: the labelled error as today', async () => {
    scriptTurns([{ type: 'error', error: creditError() }]);
    const events = await drain(makeLayer());
    expect(types(events)).toEqual(['error']);
  });

  it('e. armed + model-not-found: one request, reason model-rejected', async () => {
    const err = modelNotFound();
    scriptTurns([{ type: 'error', error: err }]);
    const events = await drain(makeLayer({ armed: true }));
    expect(types(events)).toEqual(['model.fallback_request']);
    expect(fallbackRequests(events)[0]?.reason).toBe('model-rejected');
    expect(fallbackRequests(events)[0]?.error).toBe(err);
  });

  it('e. armed + a non-model 400 is yielded as today', async () => {
    const err = promptTooLong();
    scriptTurns([{ type: 'error', error: err }]);
    const events = await drain(makeLayer({ armed: true }));
    expect(events).toEqual([{ type: 'error', error: err }]);
  });

  it('e. not armed + model-not-found is yielded as today', async () => {
    const err = modelNotFound();
    scriptTurns([{ type: 'error', error: err }]);
    expect(await drain(makeLayer())).toEqual([{ type: 'error', error: err }]);
  });

  it('e. armed + model rejection after progress is yielded as today', async () => {
    const err = modelNotFound();
    scriptTurns([{ type: 'delta.text', text: 'x', sessionId: 's1' }, { type: 'error', error: err }]);
    expect(types(await drain(makeLayer({ armed: true })))).toEqual(['delta.text', 'error']);
  });
});

describe('usage-limit tier model fallback: progress shared across overload probes', () => {
  it('g. progress forwarded by an earlier overload probe makes a later 429 ineligible', async () => {
    vi.useFakeTimers();
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '600000';
    scriptTurns(
      [{ type: 'delta.text', text: 'partial', sessionId: 's1' }, exhausted],
      [{ type: 'error', error: limit429() }],
    );
    const promise = drain(makeLayer({ armed: true, autoResume: false, surface: 'cli' }));
    await vi.advanceTimersByTimeAsync(130_000);
    const events = await promise;
    expect(runTurnMock).toHaveBeenCalledTimes(2);
    expect(fallbackRequests(events)).toHaveLength(0);
    expect(types(events)).toEqual(['delta.text', 'stream.retry', 'paused', 'error']);
  });

  it('g. control: an overload probe that forwarded only stream.retry stays eligible', async () => {
    vi.useFakeTimers();
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '600000';
    scriptTurns([{ type: 'stream.retry', sessionId: 's1' }, { type: 'error', error: limit429() }]);
    const events = await drain(makeLayer({ armed: true, surface: 'cli' }));
    expect(types(events)).toEqual(['stream.retry', 'model.fallback_request']);
  });
});
