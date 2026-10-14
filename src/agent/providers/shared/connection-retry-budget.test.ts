import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRetryBudget, connectionFailureMetadata } from './connection-retry-budget.js';
import { createWithRetry } from '../anthropic-direct/loop/connection-create.js';
import type { AnthropicMessagesCreateParams } from '../anthropic-direct/types.js';
import { runConnectionPhase } from '../openai-compatible/query/stream-drive.connection.js';
import type { TraceSink, TraceEventInput } from '../../trace/index.js';

class APIConnectionTimeoutError extends Error {}
const params = {} as AnthropicMessagesCreateParams;
const stream: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() {} };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each(['anthropic', 'openai'] as const)('%s connection wall budget', (provider) => {
  function run(create: () => Promise<AsyncIterable<unknown>>, signal = new AbortController().signal) {
    if (provider === 'anthropic') return createWithRetry({ messages: { create } }, params, {}, signal, signal)
      .then(value => ({ value }), (error: unknown) => ({ error }));
    return runConnectionPhase(create, signal, signal, undefined, 'test')
      .then(result => result.ok ? { value: result.stream } : { error: result.error });
  }
  function setup(budget?: string) {
    vi.useFakeTimers(); vi.setSystemTime(0);
    vi.stubEnv('AFK_CONNECT_RETRY_BUDGET_MS', budget);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  }
  it('records each failure, final exhaustion and recovery without diagnostic control flow', async () => {
    setup('3000');
    const events: Array<{ phase: string; metadata?: Record<string, unknown> }> = [];
    const writer: TraceSink = { getTracePath: () => 'in-memory://test', async write(event: TraceEventInput) {
      if (event.kind === 'session_phase') events.push(event.payload);
    } };
    let failures = 1;
    const create = vi.fn(async () => { if (failures-- > 0) throw new APIConnectionTimeoutError(); return stream; });
    const signal = new AbortController().signal;
    const invoke = () => provider === 'anthropic'
      ? createWithRetry({ messages: { create }, baseURL: 'https://user:secret@api.example.com/v1' }, params, {}, signal, signal, undefined, event => events.push(event))
      : runConnectionPhase(create, signal, signal, writer, 'test', 'https://user:secret@api.example.com/v1');
    const recovered = invoke(); await vi.runAllTimersAsync(); await recovered;
    expect(events.find(event => event.phase === 'connection_failure')?.metadata).toMatchObject({ host: 'api.example.com', budgetMs: 3000, errorCode: 'unknown' });
    expect(events.find(event => event.phase === 'connection_recovered')?.metadata).toMatchObject({ attempts: 2 });
    events.length = 0; failures = 100;
    const exhausted = invoke().catch(() => undefined); await vi.runAllTimersAsync(); await exhausted;
    expect(events.at(-1)?.phase).toBe('connection_budget_exhausted');
    expect(JSON.stringify(events)).not.toContain('secret');
  });
  it('does not let a failing diagnostic callback change recovery', async () => {
    setup('3000');
    let failures = 1;
    const create = vi.fn(async () => { if (failures-- > 0) throw new APIConnectionTimeoutError(); return stream; });
    const signal = new AbortController().signal;
    const writer: TraceSink = { getTracePath: () => 'in-memory://broken', async write() { throw new Error('trace failed'); } };
    const result = provider === 'anthropic'
      ? createWithRetry({ messages: { create } }, params, {}, signal, signal, undefined, () => { throw new Error('trace failed'); })
      : runConnectionPhase(create, signal, signal, writer, 'test');
    await vi.runAllTimersAsync(); await result;
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('recovers after more failures than the legacy count permits', async () => {
    setup('120000');
    let calls = 0;
    const create = vi.fn(async () => { if (++calls <= 5) throw new APIConnectionTimeoutError(); return stream; });
    const result = run(create); await vi.runAllTimersAsync();
    expect(await result).toEqual({ value: stream }); expect(calls).toBe(6);
  });
  it('exhausts at the deadline with the original class and no further attempt', async () => {
    setup('120000');
    const error = new APIConnectionTimeoutError('connect timed out');
    const create = vi.fn(async () => { throw error; });
    const result = run(create); await vi.runAllTimersAsync();
    expect(await result).toEqual({ error }); expect(Date.now()).toBe(120000);
    const calls = create.mock.calls.length; await vi.advanceTimersByTimeAsync(10000);
    expect(create).toHaveBeenCalledTimes(calls);
  });
  it('allows only an already active bounded connect to overshoot the deadline', async () => {
    setup('12000');
    const error = new APIConnectionTimeoutError();
    const create = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 10000)); throw error; });
    const result = run(create); await vi.runAllTimersAsync();
    expect(await result).toEqual({ error }); expect(Date.now()).toBeLessThanOrEqual(22000);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('cancels backoff immediately without another attempt', async () => {
    setup('120000'); const controller = new AbortController();
    const create = vi.fn(async () => { throw new APIConnectionTimeoutError(); });
    let finished = false;
    const result = run(create, controller.signal).then(value => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(50); controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true); expect(Date.now()).toBe(50); expect(create).toHaveBeenCalledTimes(1);
    const value = await result; expect('error' in value).toBe(true);
    if (provider === 'openai') expect(value).toEqual({ error: 'aborted' });
    else expect((value as { error: Error }).error.message).toBe('aborted');
  });
  it('unset preserves count and exact legacy wait schedule', async () => {
    setup();
    const create = vi.fn(async () => { throw new APIConnectionTimeoutError(); });
    const result = run(create); await vi.runAllTimersAsync(); await result;
    expect(create).toHaveBeenCalledTimes(provider === 'anthropic' ? 3 : 4);
    // Anthropic legacy additive jitter is 0..25%; OpenAI has no jitter.
    expect(Date.now()).toBe(provider === 'anthropic' ? 3375 : 14000);
  });
  it('does not retry iterator errors once the opener returned', async () => {
    setup('120000'); const error = new APIConnectionTimeoutError();
    const create = vi.fn(async () => ({ async *[Symbol.asyncIterator]() { yield 'first'; throw error; } }));
    const result = await run(create);
    expect('value' in result).toBe(true);
    if ('value' in result && result.value) {
      const iterator = result.value[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ value: 'first', done: false });
      await expect(iterator.next()).rejects.toBe(error);
    }
    expect(create).toHaveBeenCalledTimes(1);
  });
});

it('extracts bounded cause codes and hostname only, with lag measurements', () => {
  const budget = new ConnectionRetryBudget();
  const metadata = connectionFailureMetadata({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, budget, 'https://user:secret@api.example.com/path?key=secret');
  expect(metadata).toMatchObject({ errorCode: 'UND_ERR_CONNECT_TIMEOUT', host: 'api.example.com', budgetMs: 0 });
  expect(metadata['loopLagP99Ms']).toBeGreaterThanOrEqual(0);
  expect(metadata['loopLagMaxMs']).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(metadata)).not.toContain('secret');
});

it.each(['', '0', '-1', 'NaN', 'Infinity', 'abc'])('invalid budget %s retains the count policy', value => {
  vi.stubEnv('AFK_CONNECT_RETRY_BUDGET_MS', value);
  const budget = new ConnectionRetryBudget(); expect(budget.budgetMs).toBeUndefined();
  expect(budget.canRetry(2, 2)).toBe(false);
});
