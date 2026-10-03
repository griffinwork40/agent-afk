// Connection-phase network retry (regression from #2422 / PR #2702).
//
// With the SDK's own retries disabled (`maxRetries: 0`), a single stale-socket
// or DNS blip on `messages.create` surfaced as a fatal
// `APIConnectionError: Connection error.` and killed the turn. These tests pin
// both the classifier and the retry behaviour in `createWithRetry`, including
// status-bearing connection-phase errors (408/409/500/502/504) added in PR #2838
// and the SDK connect timeout (`APIConnectionTimeoutError`) added after it.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CONNECTION_ERROR_MAX_RETRIES,
  connectionErrorCode,
  connectionRetryMetadata,
  isConnectionPhaseNetworkError,
  isConnectionTimeoutError,
} from './connection-error.js';
import { createWithRetry, type ConnectionRetryInfo } from './round-request.js';
import type { AnthropicMessagesCreateParams } from '../types.js';

// Local stand-ins with the SDK's exact constructor names and shapes (no `name`
// override, no `status`), so this file needs no runtime SDK import (the
// audit:sdk lock). The classifier keys on `constructor.name`; the published
// bundle keeps identifiers (build-dist.mjs `minifyIdentifiers: false`).
class APIConnectionError extends Error {
  readonly status: undefined = undefined;
  constructor({ message, cause }: { message?: string | undefined; cause?: unknown }) {
    super(message ?? 'Connection error.');
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
class APIConnectionTimeoutError extends APIConnectionError {
  constructor() {
    super({ message: 'Request timed out.' });
  }
}
class APIError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sdkConnectionError(code?: string): Error {
  const cause = code !== undefined
    ? Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`read ${code}`), { code }) })
    : undefined;
  return new APIConnectionError(cause !== undefined ? { cause } : { message: undefined });
}

describe('isConnectionPhaseNetworkError', () => {
  it('matches the real SDK APIConnectionError ("Connection error.")', () => {
    const err = sdkConnectionError('ECONNRESET');
    expect(err.message).toBe('Connection error.');
    expect(isConnectionPhaseNetworkError(err)).toBe(true);
  });

  it('matches an APIConnectionError with no cause at all', () => {
    expect(isConnectionPhaseNetworkError(sdkConnectionError())).toBe(true);
  });

  it('matches a bare socket/DNS code anywhere on the cause chain', () => {
    // Non-SDK shape (a raw fetch rejection). The SDK itself never surfaces a
    // connect timeout this way: it maps any "timed out" rejection to a cause-less
    // APIConnectionTimeoutError, covered by the createWithRetry timeout tests.
    for (const code of ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']) {
      const err = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) });
      expect(isConnectionPhaseNetworkError(err)).toBe(true);
    }
  });

  it('does NOT match the SDK timeout (classified by isConnectionTimeoutError instead)', () => {
    expect(isConnectionPhaseNetworkError(new APIConnectionTimeoutError())).toBe(false);
  });

  it('isConnectionTimeoutError matches only the exact SDK timeout class', () => {
    expect(isConnectionTimeoutError(new APIConnectionTimeoutError())).toBe(true);
    expect(isConnectionTimeoutError(sdkConnectionError('ECONNRESET'))).toBe(false);
    expect(isConnectionTimeoutError(new Error('Request timed out.'))).toBe(false);
    expect(isConnectionTimeoutError(null)).toBe(false);
  });

  it('does NOT match errors carrying an HTTP status', () => {
    const err = new APIError(400, 'bad');
    expect(isConnectionPhaseNetworkError(err)).toBe(false);
  });

  it('does NOT match unrelated errors, and survives a self-referential cause', () => {
    expect(isConnectionPhaseNetworkError(new Error('Connection lost to MCP server'))).toBe(false);
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;
    expect(isConnectionPhaseNetworkError(loop)).toBe(false);
    expect(isConnectionPhaseNetworkError(null)).toBe(false);
    expect(isConnectionPhaseNetworkError('Connection error.')).toBe(false);
  });

  it('connectionErrorCode digs the code out of the cause chain', () => {
    expect(connectionErrorCode(sdkConnectionError('ECONNRESET'))).toBe('ECONNRESET');
    expect(connectionErrorCode(sdkConnectionError())).toBeUndefined();
  });
});

describe('createWithRetry: connection-phase network failures', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const params = {} as AnthropicMessagesCreateParams;
  const stream: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() { /* empty */ } };

  function clientFailing(times: number, makeErr: () => unknown) {
    let calls = 0;
    const create = vi.fn(async () => {
      calls++;
      if (calls <= times) throw makeErr();
      return stream;
    });
    return { client: { messages: { create } }, create };
  }

  async function run(client: { messages: { create(p: unknown, o: unknown): unknown } }, onRetry?: (i: ConnectionRetryInfo) => void, requestSignal?: AbortSignal) {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const p = createWithRetry(client, params, {}, requestSignal ?? signal, signal, onRetry);
    // Attach a handler now so a rejection during timer advance is not unhandled.
    const settled = p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    await vi.runAllTimersAsync();
    return settled;
  }

  it('retries a single connection blip and returns the stream (the reported bug)', async () => {
    const { client, create } = clientFailing(1, () => sdkConnectionError('ECONNRESET'));
    const retries: ConnectionRetryInfo[] = [];
    const res = await run(client, (i) => retries.push(i));
    expect(res.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.attempt).toBe(1);
    expect(retries[0]?.delayMs).toBeGreaterThan(0);
  });

  it('gives up after CONNECTION_ERROR_MAX_RETRIES and rethrows the original error', async () => {
    const { client, create } = clientFailing(Infinity, () => sdkConnectionError('ENOTFOUND'));
    const res = await run(client);
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.e as Error).message).toBe('Connection error.');
    expect(create).toHaveBeenCalledTimes(CONNECTION_ERROR_MAX_RETRIES + 1);
  });

  it('retries an SDK connect timeout (cause-less APIConnectionTimeoutError) while the request signal is live', async () => {
    // undici's 10s ConnectTimeoutError reaches us in exactly this shape; the
    // TTFB watchdog (180s) has not fired, so before this fix the turn died.
    const { client, create } = clientFailing(1, () => new APIConnectionTimeoutError());
    const retries: ConnectionRetryInfo[] = [];
    const res = await run(client, (i) => retries.push(i));
    expect(res.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(retries).toHaveLength(1);
  });

  it('gives up on a persistent connect timeout after CONNECTION_ERROR_MAX_RETRIES', async () => {
    const { client, create } = clientFailing(Infinity, () => new APIConnectionTimeoutError());
    const res = await run(client);
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.e as Error).message).toBe('Request timed out.');
    expect(create).toHaveBeenCalledTimes(CONNECTION_ERROR_MAX_RETRIES + 1);
  });

  it('does not retry a timeout once the request signal is aborted (TTFB watchdog owns it)', async () => {
    const ac = new AbortController();
    ac.abort();
    const { client, create } = clientFailing(1, () => new APIConnectionTimeoutError());
    const res = await run(client, undefined, ac.signal);
    expect(res.ok).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('wakes from the connection-retry backoff when the turn is aborted mid-sleep', async () => {
    vi.useFakeTimers();
    const { client, create } = clientFailing(1, () => sdkConnectionError('ECONNRESET'));
    const turn = new AbortController();
    const p = createWithRetry(client, params, {}, turn.signal, turn.signal);
    const settled = p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    await vi.advanceTimersByTimeAsync(100); // inside the >=1s backoff
    turn.abort();
    await vi.runAllTimersAsync();
    const res = await settled;
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.e as Error).message).toBe('aborted');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the request signal was aborted (user interrupt / TTFB)', async () => {
    const ac = new AbortController();
    ac.abort();
    const { client, create } = clientFailing(1, () => sdkConnectionError('ECONNRESET'));
    const res = await run(client, undefined, ac.signal);
    expect(res.ok).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-network error', async () => {
    const { client, create } = clientFailing(1, () => new Error('boom'));
    const res = await run(client);
    expect(res.ok).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('createWithRetry: connection-phase status retries (408/500/502/504)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const params = {} as AnthropicMessagesCreateParams;
  const stream: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() { /* empty */ } };

  function clientFailing(times: number, makeErr: () => unknown) {
    let calls = 0;
    const create = vi.fn(async () => {
      calls++;
      if (calls <= times) throw makeErr();
      return stream;
    });
    return { client: { messages: { create } }, create };
  }

  async function run(client: { messages: { create(p: unknown, o: unknown): unknown } }, onRetry?: (i: ConnectionRetryInfo) => void) {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const p = createWithRetry(client, params, {}, signal, signal, onRetry);
    const settled = p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    await vi.runAllTimersAsync();
    return settled;
  }

  for (const status of [500, 502, 504, 408, 409]) {
    it(`retries a ${status} status error via connection budget and succeeds`, async () => {
      const { client, create } = clientFailing(1, () => new APIError(status, `http ${status}`));
      const retries: ConnectionRetryInfo[] = [];
      const res = await run(client, (i) => retries.push(i));
      expect(res.ok).toBe(true);
      expect(create).toHaveBeenCalledTimes(2);
      expect(retries).toHaveLength(1);
      expect(retries[0]?.attempt).toBe(1);
    });
  }

  it('gives up after CONNECTION_ERROR_MAX_RETRIES on a persistent 502', async () => {
    const { client, create } = clientFailing(Infinity, () => new APIError(502, 'Bad Gateway'));
    const res = await run(client);
    expect(res.ok).toBe(false);
    expect(create).toHaveBeenCalledTimes(CONNECTION_ERROR_MAX_RETRIES + 1);
  });

  it('routes 529 to the overload budget (not the connection budget)', async () => {
    // 529 is handled by isTransientServerError → overload budget (OVERLOAD_MAX_RETRIES=3),
    // NOT by isRetryableConnectionStatus → connection budget (CONNECTION_ERROR_MAX_RETRIES=2).
    // A persistent 529 exhausts the overload budget and throws ConnectionOverloadExhaustedError.
    const { client, create } = clientFailing(Infinity, () => new APIError(529, 'Overloaded'));
    const res = await run(client);
    expect(res.ok).toBe(false);
    // Overload budget: 3 retries → 4 total calls (1 initial + 3 retries), then sentinel thrown.
    expect(create).toHaveBeenCalledTimes(4);
    // The error from createWithRetry is the ConnectionOverloadExhaustedError sentinel,
    // not the raw 529 APIError.
    if (!res.ok) expect((res.e as Error).message).toMatch(/overload/i);
  });

  it('routes 503 to the overload budget (not the connection budget)', async () => {
    const { client, create } = clientFailing(Infinity, () => new APIError(503, 'Service Unavailable'));
    const res = await run(client);
    expect(res.ok).toBe(false);
    expect(create).toHaveBeenCalledTimes(4);
    if (!res.ok) expect((res.e as Error).message).toMatch(/overload/i);
  });
});

describe('connectionRetryMetadata (connection_retry trace payload)', () => {
  it('records attempt, maxRetries, code, and the error text', () => {
    const md = connectionRetryMetadata({ attempt: 1, error: sdkConnectionError('ECONNRESET') });
    expect(md).toEqual({
      attempt: 1,
      maxRetries: CONNECTION_ERROR_MAX_RETRIES,
      error: 'Connection error.',
      code: 'ECONNRESET',
    });
  });

  it('includes status for a status-bearing retry and omits absent code', () => {
    const md = connectionRetryMetadata({ attempt: 2, error: new APIError(502, 'Bad Gateway') });
    expect(md['status']).toBe(502);
    expect(md).not.toHaveProperty('code');
  });

  it('redacts secrets echoed in an error body before it reaches the trace', () => {
    const key = `sk-ant-${'a'.repeat(40)}`;
    const md = connectionRetryMetadata({
      attempt: 1,
      error: new APIError(502, `502 upstream said: Authorization: Bearer ${key}`),
    });
    expect(String(md['error'])).not.toContain(key);
    expect(String(md['error'])).toContain('[REDACTED]');
  });

  it('truncates long error text to 200 characters before redaction', () => {
    const md = connectionRetryMetadata({ attempt: 1, error: new APIError(500, 'x'.repeat(500)) });
    expect(String(md['error']).length).toBeLessThanOrEqual(200);
  });
});
