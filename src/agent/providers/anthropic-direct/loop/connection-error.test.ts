// Connection-phase network retry (regression from #2422 / PR #2702).
//
// With the SDK's own retries disabled (`maxRetries: 0`), a single stale-socket
// or DNS blip on `messages.create` surfaced as a fatal
// `APIConnectionError: Connection error.` and killed the turn. These tests pin
// both the classifier and the retry behaviour in `createWithRetry`.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CONNECTION_ERROR_MAX_RETRIES,
  connectionErrorCode,
  isConnectionPhaseNetworkError,
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
    for (const code of ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']) {
      const err = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) });
      expect(isConnectionPhaseNetworkError(err)).toBe(true);
    }
  });

  it('does NOT match the SDK request timeout (TTFB watchdog owns that window)', () => {
    expect(isConnectionPhaseNetworkError(new APIConnectionTimeoutError())).toBe(false);
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

  it('does not retry an SDK request timeout', async () => {
    const { client, create } = clientFailing(1, () => new APIConnectionTimeoutError());
    const res = await run(client);
    expect(res.ok).toBe(false);
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
