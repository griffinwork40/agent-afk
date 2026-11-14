/**
 * Model-fallback requests from the openai-compatible quota tier
 * (usage-limit-tier.fallback.ts wired into `runIterationWithQuotaLimitPause`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { ProviderEvent } from '../../../provider.js';
import { runIterationWithQuotaLimitPause, __setQuotaOverrides } from './usage-limit-tier.js';
import type { QuotaFallbackContext } from './usage-limit-tier.fallback.js';
import { isFallbackProgress } from './usage-limit-tier.fallback.js';
import type { IterationResult } from './stream-drive.js';
import { createStreamState } from '../translate.js';
import { ModelRejectedError } from '../../shared/model-rejected-error.js';

afterEach(() => __setQuotaOverrides({ fallbackWaitMs: null, twoHoursMs: null }));

function quota429(): Error {
  return Object.assign(new Error('http 429'), { status: 429, headers: { 'retry-after': '600' } });
}

function modelNotFound(): Error {
  return Object.assign(new Error('The model `gpt-x` does not exist'), {
    status: 404, code: 'model_not_found', error: { code: 'model_not_found', message: 'The model `gpt-x` does not exist' },
  });
}

function bad400(): Error {
  return Object.assign(new Error('prompt too long'), {
    status: 400, error: { type: 'invalid_request_error', message: 'prompt is too long' },
  });
}

function successResult(): IterationResult {
  const state = createStreamState();
  state.finishReason = 'stop';
  return { state, events: [], text: 'done', needsToolDispatch: false };
}

/** One iteration per entry; the last entry repeats. Counts calls. */
function iterations(...runs: Array<{ events: ProviderEvent[]; result: IterationResult | null }>) {
  let calls = 0;
  const make = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
    const run = runs[Math.min(calls, runs.length - 1)]!;
    calls += 1;
    return (async function* () {
      for (const e of run.events) yield e;
      return run.result;
    })();
  };
  return { make, calls: () => calls };
}

function fb(over: Partial<QuotaFallbackContext> = {}): QuotaFallbackContext {
  return { firstRequestOfTurn: true, isArmed: () => true, model: 'gpt-x', ...over };
}

async function runTier(
  make: () => AsyncGenerator<ProviderEvent, IterationResult | null>,
  opts: Partial<Parameters<typeof runIterationWithQuotaLimitPause>[1]> = {},
): Promise<{ events: ProviderEvent[]; result: IterationResult | null }> {
  const tier = runIterationWithQuotaLimitPause(make, {
    autoResumeOnUsageLimit: true,
    traceWriter: undefined,
    signal: new AbortController().signal,
    isClosed: () => false,
    sessionId: 'sess-1',
    ...opts,
  });
  const events: ProviderEvent[] = [];
  for (;;) {
    const step = await tier.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

const types = (events: ProviderEvent[]) => events.map((e) => e.type);

describe('quota tier model-fallback request', () => {
  it('(a) armed + first request + quota 429: exactly one usage-limit request carrying the original error', async () => {
    const err = quota429();
    const it1 = iterations({ events: [{ type: 'error', error: err }], result: null });
    const { events, result } = await runTier(it1.make, { fallback: fb() });
    expect(result).toBeNull();
    expect(events).toEqual([{ type: 'model.fallback_request', reason: 'usage-limit', error: err, sessionId: 'sess-1' }]);
    expect(events[0]!.type === 'model.fallback_request' && events[0]!.error).toBe(err);
    expect(it1.calls()).toBe(1);
  });

  it('(a) stream.retry and a fast-tier notice before the 429 do not count as progress', async () => {
    const it1 = iterations({
      events: [
        { type: 'stream.retry', sessionId: 'sess-1' },
        { type: 'notice', text: 'tier downgraded', kind: 'fast-tier', sessionId: 'sess-1' },
        { type: 'error', error: quota429() },
      ],
      result: null,
    });
    const { events } = await runTier(it1.make, { fallback: fb() });
    expect(types(events)).toEqual(['stream.retry', 'notice', 'model.fallback_request']);
  });

  it('(b) armed but not the first request of the turn (round > 0): parks as today', async () => {
    __setQuotaOverrides({ fallbackWaitMs: 1 });
    const it1 = iterations(
      { events: [{ type: 'error', error: quota429() }], result: null },
      { events: [], result: successResult() },
    );
    // retry-after 600s would wait; the tier honours it, so use a far-reset-free fail-fast surface.
    const { events } = await runTier(it1.make, { fallback: fb({ firstRequestOfTurn: false }), autoResumeOnUsageLimit: false });
    expect(types(events)).toEqual(['paused', 'error']);
  });

  it('(c) armed + first request but progress already yielded in the iteration: parks as today', async () => {
    const it1 = iterations({
      events: [{ type: 'delta.text', text: 'hi', sessionId: 'sess-1' }, { type: 'error', error: quota429() }],
      result: null,
    });
    const { events } = await runTier(it1.make, { fallback: fb(), autoResumeOnUsageLimit: false });
    expect(types(events)).toEqual(['delta.text', 'paused', 'error']);
  });

  it('(d) not armed: unchanged (paused then error on fail-fast; no request)', async () => {
    const it1 = iterations({ events: [{ type: 'error', error: quota429() }], result: null });
    const { events } = await runTier(it1.make, { fallback: fb({ isArmed: () => false }), autoResumeOnUsageLimit: false });
    expect(types(events)).toEqual(['paused', 'error']);
  });

  it('(d) no fallback wiring at all: unchanged', async () => {
    const it1 = iterations({ events: [{ type: 'error', error: quota429() }], result: null });
    const { events } = await runTier(it1.make, { autoResumeOnUsageLimit: false });
    expect(types(events)).toEqual(['paused', 'error']);
  });

  it('(e) armed + model rejection on the first request: one model-rejected request with the original error', async () => {
    const err = modelNotFound();
    const it1 = iterations({ events: [{ type: 'error', error: err }], result: null });
    const { events, result } = await runTier(it1.make, { fallback: fb() });
    expect(result).toBeNull();
    expect(events).toEqual([{ type: 'model.fallback_request', reason: 'model-rejected', error: err, sessionId: 'sess-1' }]);
  });

  it('(e) a typed ModelRejectedError (ChatGPT backend) is recognised', async () => {
    const err = new ModelRejectedError('rejected', 'claude-x', undefined, 'openai-compatible');
    const it1 = iterations({ events: [{ type: 'error', error: err }], result: null });
    const { events } = await runTier(it1.make, { fallback: fb({ model: 'claude-x' }) });
    expect(types(events)).toEqual(['model.fallback_request']);
  });

  it('(e) an unrelated 400 is yielded as today', async () => {
    const err = bad400();
    const it1 = iterations({ events: [{ type: 'error', error: err }], result: null });
    const { events } = await runTier(it1.make, { fallback: fb() });
    expect(events).toEqual([{ type: 'error', error: err }]);
  });

  it('(e) a model rejection after progress, or when not armed, is yielded as today', async () => {
    const late = iterations({
      events: [{ type: 'delta.text', text: 'x', sessionId: 'sess-1' }, { type: 'error', error: modelNotFound() }],
      result: null,
    });
    expect(types((await runTier(late.make, { fallback: fb() })).events)).toEqual(['delta.text', 'error']);
    const off = iterations({ events: [{ type: 'error', error: modelNotFound() }], result: null });
    expect(types((await runTier(off.make, { fallback: fb({ isArmed: () => false }) })).events)).toEqual(['error']);
    const later = iterations({ events: [{ type: 'error', error: modelNotFound() }], result: null });
    expect(types((await runTier(later.make, { fallback: fb({ firstRequestOfTurn: false }) })).events)).toEqual(['error']);
  });

  it('(f) autoResumeOnUsageLimit=false + armed + first request: request, not fail-fast', async () => {
    const it1 = iterations({ events: [{ type: 'error', error: quota429() }], result: null });
    const { events } = await runTier(it1.make, { fallback: fb(), autoResumeOnUsageLimit: false });
    expect(types(events)).toEqual(['model.fallback_request']);
  });

  it('(g) the armed predicate is read live at decision time, not at construction', async () => {
    let armed = false;
    let reads = 0;
    const it1 = iterations({ events: [{ type: 'error', error: quota429() }], result: null });
    const tier = runIterationWithQuotaLimitPause(it1.make, {
      autoResumeOnUsageLimit: false,
      traceWriter: undefined,
      signal: new AbortController().signal,
      isClosed: () => false,
      sessionId: 'sess-1',
      fallback: fb({ isArmed: () => { reads += 1; return armed; } }),
    });
    expect(reads).toBe(0);
    armed = true;
    const first = await tier.next();
    expect(first.value).toMatchObject({ type: 'model.fallback_request' });
    expect(reads).toBe(1);
  });

  it('a clean iteration never consults the predicate', async () => {
    let reads = 0;
    const it1 = iterations({ events: [{ type: 'assistant.message', text: 'ok', sessionId: 'sess-1' }], result: successResult() });
    const { events, result } = await runTier(it1.make, { fallback: fb({ isArmed: () => { reads += 1; return true; } }) });
    expect(types(events)).toEqual(['assistant.message']);
    expect(result).not.toBeNull();
    expect(reads).toBe(0);
  });
});

describe('isFallbackProgress', () => {
  it('excludes stream.retry and fast-tier notices only', () => {
    expect(isFallbackProgress({ type: 'stream.retry', sessionId: 's' })).toBe(false);
    expect(isFallbackProgress({ type: 'notice', text: 't', kind: 'fast-tier' })).toBe(false);
    expect(isFallbackProgress({ type: 'notice', text: 't', kind: 'truncation' })).toBe(true);
    expect(isFallbackProgress({ type: 'assistant.message', text: 't', sessionId: 's' })).toBe(true);
    expect(isFallbackProgress({ type: 'paused', reason: 'usage-limit', autoResume: true } as ProviderEvent)).toBe(true);
  });
});
