/**
 * Integration tests for OAuth token refresh retry flow in `turnWithAuthRetry()`.
 *
 * Tests the full 401 → refresh → retry cycle. Since `turnWithAuthRetry()` is
 * a private method, we test it through the public `run()` generator by mocking
 * the Anthropic SDK to emit 401 errors on the first call and success on the
 * retry.
 *
 * Coverage:
 *  - 401 error → successful refresh → retry succeeds (happy path)
 *  - 401 error → refresher returns null → original 401 surfaces
 *  - 401 error → refresher throws → original 401 surfaces
 *  - Non-401 error → no refresh attempted, error surfaces normally
 *  - Successful turn → refresher never called
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import {
  AnthropicDirectProvider,
  __setAnthropicClientFactory,
} from './index.js';

// --- Mock SDK plumbing ---

type CreateArgs = [
  Record<string, unknown>,
  { headers?: Record<string, string>; signal?: AbortSignal } | undefined,
];

const messagesCreateMock = vi.fn();
const anthropicCtorMock = vi.fn();

class MockAnthropic {
  public opts: unknown;
  public messages: { create: typeof messagesCreateMock };
  constructor(opts: unknown) {
    anthropicCtorMock(opts);
    this.opts = opts;
    this.messages = { create: messagesCreateMock };
  }
}

function installFactory(): void {
  __setAnthropicClientFactory(
    (opts) => new MockAnthropic(opts) as unknown as Anthropic,
  );
}

// --- Helpers ---

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

/** A prompt stream we can push user turns to over the life of the test. */
function createPushStream(): {
  push: (item: { content: string }) => void;
  close: () => void;
  iterable: AsyncIterable<{ content: string }>;
} {
  const queue: Array<{ content: string }> = [];
  let waiting: ((r: IteratorResult<{ content: string }>) => void) | null = null;
  let closed = false;
  return {
    push(item): void {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: item, done: false });
      } else {
        queue.push(item);
      }
    },
    close(): void {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined as unknown as { content: string }, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<{ content: string }> {
        return {
          next(): Promise<IteratorResult<{ content: string }>> {
            const head = queue.shift();
            if (head !== undefined) return Promise.resolve({ value: head, done: false });
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as { content: string }, done: true });
            }
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
        };
      },
    },
  };
}

/** Build a minimal text-only stream that ends with stop_reason=end_turn. */
function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Create a 401 error object matching the SDK's shape. */
function make401Error(): Error {
  const error = new Error('Unauthorized');
  (error as unknown as { status: number }).status = 401;
  return error;
}

// --- Tests ---

describe('AnthropicDirectProvider — OAuth token refresh retry', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    anthropicCtorMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
  });

  it('401 error → successful refresh → retry succeeds (happy path)', async () => {
    // First call throws 401, second call (after refresh) returns text.
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        throw make401Error();
      }
      return fromArray(makeTextStream('Success after refresh'));
    });

    let refresherCalled = false;
    const mockRefresher = vi.fn(async (): Promise<Anthropic | null> => {
      refresherCalled = true;
      return new MockAnthropic({ authToken: 'sk-ant-oat01-fresh' }) as unknown as Anthropic;
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    // Inject the refresher after construction by accessing the private field via type coercion.
    const queryAny = query as unknown as { retry: { tokenRefresher?: () => Promise<Anthropic | null> } };
    queryAny.retry.tokenRefresher = mockRefresher;

    const events = await collect(query);

    // Verify that refresher was called.
    expect(refresherCalled).toBe(true);
    expect(mockRefresher).toHaveBeenCalledOnce();

    // Verify that messages.create was called twice (initial 401 + retry).
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);

    // Verify that the turn completed successfully with the retried response.
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('end_turn');
    }

    const message = events.find((e) => e.type === 'assistant.message');
    expect(message).toBeDefined();
    if (message?.type === 'assistant.message') {
      expect(message.text).toBe('Success after refresh');
    }

    // Verify that no error event was surfaced.
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(0);
  });

  it('401 error → refresher returns null → original 401 error is surfaced', async () => {
    messagesCreateMock.mockImplementation(() => {
      throw make401Error();
    });

    let refresherCalled = false;
    const mockRefresher = vi.fn(async (): Promise<Anthropic | null> => {
      refresherCalled = true;
      return null; // Refresh failed
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    const queryAny = query as unknown as { retry: { tokenRefresher?: () => Promise<Anthropic | null> } };
    queryAny.retry.tokenRefresher = mockRefresher;

    const events = await collect(query);

    // Verify that refresher was called.
    expect(refresherCalled).toBe(true);
    expect(mockRefresher).toHaveBeenCalledOnce();

    // Only one call to messages.create (the initial 401, no retry).
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);

    // Verify that the original 401 error was surfaced.
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    if (errorEvents[0]?.type === 'error') {
      expect(errorEvents[0].error.message).toBe('Unauthorized');
      expect((errorEvents[0].error as unknown as { status: number }).status).toBe(401);
    }

    // No turn.completed should be emitted.
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeUndefined();
  });

  it('401 error → refresher throws → original 401 error is surfaced', async () => {
    messagesCreateMock.mockImplementation(() => {
      throw make401Error();
    });

    let refresherCalled = false;
    const mockRefresher = vi.fn(async (): Promise<Anthropic | null> => {
      refresherCalled = true;
      throw new Error('Keychain access denied');
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    const queryAny = query as unknown as { retry: { tokenRefresher?: () => Promise<Anthropic | null> } };
    queryAny.retry.tokenRefresher = mockRefresher;

    const events = await collect(query);

    // Verify that refresher was called (and threw).
    expect(refresherCalled).toBe(true);
    expect(mockRefresher).toHaveBeenCalledOnce();

    // Only one call to messages.create (the initial 401, no retry).
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);

    // Verify that the original 401 error was surfaced (not the refresher's error).
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    if (errorEvents[0]?.type === 'error') {
      expect(errorEvents[0].error.message).toBe('Unauthorized');
      expect((errorEvents[0].error as unknown as { status: number }).status).toBe(401);
    }
  });

  it('non-401 error → no refresh attempted, error surfaces normally', async () => {
    const mockRefresher = vi.fn(async (): Promise<Anthropic | null> => {
      throw new Error('Should not be called');
    });

    const networkError = new Error('Connection timeout');
    messagesCreateMock.mockImplementation(() => {
      throw networkError;
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    const queryAny = query as unknown as { retry: { tokenRefresher?: () => Promise<Anthropic | null> } };
    queryAny.retry.tokenRefresher = mockRefresher;

    const events = await collect(query);

    // Refresher should never have been called.
    expect(mockRefresher).not.toHaveBeenCalled();

    // Only one call to messages.create.
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);

    // Error event should surface the network error.
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    if (errorEvents[0]?.type === 'error') {
      expect(errorEvents[0].error.message).toBe('Connection timeout');
    }
  });

  it('successful turn → refresher never called', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('All good')));

    const mockRefresher = vi.fn(async (): Promise<Anthropic | null> => {
      throw new Error('Should not be called');
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    const queryAny = query as unknown as { retry: { tokenRefresher?: () => Promise<Anthropic | null> } };
    queryAny.retry.tokenRefresher = mockRefresher;

    const events = await collect(query);

    // Refresher should never be called on a successful turn.
    expect(mockRefresher).not.toHaveBeenCalled();

    // Only one call to messages.create.
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);

    // Turn completed successfully.
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('end_turn');
    }

    // No error events.
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(0);
  });

  it('retried turn preserves message history and carries tool-use results forward', async () => {
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        // First call: 401 error.
        throw make401Error();
      }
      // Second call: text response after refresh.
      return fromArray(makeTextStream('Retry succeeded'));
    });

    const mockRefresher = vi.fn(async (): Promise<Anthropic | null> => {
      return new MockAnthropic({ authToken: 'sk-ant-oat01-fresh' }) as unknown as Anthropic;
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    const queryAny = query as unknown as { retry: { tokenRefresher?: () => Promise<Anthropic | null> } };
    queryAny.retry.tokenRefresher = mockRefresher;

    const events = await collect(query);

    // Verify two calls: initial request, then retry after refresh.
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);

    // Both calls should include the user input.
    const call1Params = messagesCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const call2Params = messagesCreateMock.mock.calls[1]?.[0] as Record<string, unknown>;
    const messages1 = call1Params['messages'] as Array<{ content: string }>;
    const messages2 = call2Params['messages'] as Array<{ content: string }>;

    expect(messages1.length).toBeGreaterThan(0);
    expect(messages2.length).toBeGreaterThan(0);
    // Both should have the user message.
    expect(messages1[0]?.content).toBeDefined();
    expect(messages2[0]?.content).toBeDefined();

    // Verify the turn completed successfully.
    const assistant = events.find((e) => e.type === 'assistant.message');
    expect(assistant?.type).toBe('assistant.message');
    if (assistant?.type === 'assistant.message') {
      expect(assistant.text).toBe('Retry succeeded');
    }
  });

  it('retried turn uses the fresh client and new request headers', async () => {
    const originalClient = new MockAnthropic({ authToken: 'sk-ant-oat01-old' });
    const freshClient = new MockAnthropic({ authToken: 'sk-ant-oat01-fresh' });

    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        throw make401Error();
      }
      return fromArray(makeTextStream('Done'));
    });

    const mockRefresher = vi.fn(async (): Promise<Anthropic | null> => {
      return freshClient as unknown as Anthropic;
    });

    // Set up factory to return the original client first.
    __setAnthropicClientFactory((opts) => {
      if ('authToken' in opts && opts.authToken === 'sk-ant-oat01-test') {
        return originalClient as unknown as Anthropic;
      }
      return freshClient as unknown as Anthropic;
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    const queryAny = query as unknown as { retry: { tokenRefresher?: () => Promise<Anthropic | null> } };
    queryAny.retry.tokenRefresher = mockRefresher;

    await collect(query);

    expect(mockRefresher).toHaveBeenCalledOnce();
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);

    // Verify headers were passed to both calls (request IDs should differ).
    const [, opts1] = messagesCreateMock.mock.calls[0] as CreateArgs;
    const [, opts2] = messagesCreateMock.mock.calls[1] as CreateArgs;

    expect(opts1?.headers?.['x-client-request-id']).toBeTruthy();
    expect(opts2?.headers?.['x-client-request-id']).toBeTruthy();
    // The retry should have a different request ID.
    expect(opts1?.headers?.['x-client-request-id']).not.toBe(
      opts2?.headers?.['x-client-request-id'],
    );

    // Both calls should carry the OAuth headers (oauth mode).
    expect(opts1?.headers?.['anthropic-beta']).toBeTruthy();
    expect(opts2?.headers?.['anthropic-beta']).toBeTruthy();
  });

  it('multiple turns where only the second turn gets 401', async () => {
    // This test verifies that the refresh flow works correctly on a later turn,
    // not just the first one.
    const harness = makeMultiTurnHarness(2);

    let turnCount = 0;
    messagesCreateMock.mockImplementation(() => {
      turnCount += 1;
      if (turnCount === 1) {
        // First turn succeeds.
        return fromArray(makeTextStream('Response 1'));
      }
      if (turnCount === 2) {
        // Second turn fails with 401.
        throw make401Error();
      }
      // Third turn (after refresh) succeeds.
      return fromArray(makeTextStream('Response 2 after refresh'));
    });

    const mockRefresher = vi.fn(async (): Promise<Anthropic | null> => {
      return new MockAnthropic({ authToken: 'sk-ant-oat01-fresh' }) as unknown as Anthropic;
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: harness.prompt,
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    const queryAny = query as unknown as { retry: { tokenRefresher?: () => Promise<Anthropic | null> } };
    queryAny.retry.tokenRefresher = mockRefresher;

    const drive = drainQuery(query, harness);

    // Fire first turn — should succeed without refresh.
    await harness.fireTurn(0, 'input-1');
    expect(mockRefresher).not.toHaveBeenCalled();
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);

    // Fire second turn — should fail with 401, then refresh and retry.
    await harness.fireTurn(1, 'input-2');
    expect(mockRefresher).toHaveBeenCalledOnce();
    expect(messagesCreateMock).toHaveBeenCalledTimes(3); // call 1 (success) + 2 (401) + 3 (retry)

    harness.stop();
    query.close();
    await drive;
  });
});

// --- Multi-turn harness helpers ---

interface MultiTurnHarness {
  prompt: AsyncIterable<{ content: string }>;
  onTurnCompleted: () => void;
  nextTurnCompleted(): Promise<void>;
  fireTurn(i: number, content: string): Promise<void>;
  stop(): void;
}

function makeMultiTurnHarness(turnCount: number): MultiTurnHarness {
  const cues: Array<((c: string) => void)> = [];
  const turns: Array<Promise<{ content: string }>> = [];
  for (let i = 0; i < turnCount; i++) {
    let resolve!: (c: string) => void;
    turns.push(
      new Promise<{ content: string }>((res) => {
        resolve = (c): void => res({ content: c });
      }),
    );
    cues.push(resolve);
  }
  let stopResolve!: () => void;
  const stopPromise = new Promise<void>((r) => {
    stopResolve = r;
  });
  async function* prompt(): AsyncIterable<{ content: string }> {
    for (const t of turns) yield await t;
    await stopPromise;
  }

  let pendingResolve: (() => void) | null = null;
  const harness: MultiTurnHarness = {
    prompt: prompt(),
    onTurnCompleted: (): void => {
      const r = pendingResolve;
      pendingResolve = null;
      if (r) r();
    },
    nextTurnCompleted: (): Promise<void> =>
      new Promise<void>((resolve) => {
        pendingResolve = resolve;
      }),
    fireTurn: async (i, content): Promise<void> => {
      const wait = harness.nextTurnCompleted();
      cues[i]?.(content);
      await wait;
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
    stop: (): void => stopResolve(),
  };
  return harness;
}

function drainQuery(
  query: AsyncIterable<ProviderEvent>,
  harness: MultiTurnHarness,
): Promise<void> {
  return (async (): Promise<void> => {
    for await (const ev of query) {
      if (ev.type === 'turn.completed') harness.onTurnCompleted();
    }
  })();
}

// ---------------------------------------------------------------------------
// turnWithUsageLimitRetry integration tests
// ---------------------------------------------------------------------------

/** Build a 429 error with the OAuth usage-limit shape: message contains `|<unix-ts>`. */
function make429UsageLimitError(resetsInMs = 5 * 60 * 1_000): Error {
  const unixTs = Math.floor((Date.now() + resetsInMs) / 1_000);
  const err = new Error(`Claude AI usage limit reached|${unixTs}`);
  (err as Error & { status: number }).status = 429;
  return err;
}

/** Build a 429 error WITHOUT a reset timestamp (oauth-limit-no-ts). */
function make429NoTsError(): Error {
  const err = new Error('Claude AI usage limit reached');
  (err as Error & { status: number }).status = 429;
  return err;
}

/** Build a 400 credit-exhausted error. */
function make400CreditExhaustedError(): Error {
  const err = new Error('invalid_request_error: credit balance is empty');
  (err as Error & { status: number }).status = 400;
  return err;
}

describe('AnthropicDirectProvider — turnWithUsageLimitRetry', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    anthropicCtorMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path: 429+ts → paused → timer → resumed → turn.completed', async () => {
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) throw make429UsageLimitError(5 * 60 * 1_000); // 5min reset
      return fromArray(makeTextStream('resumed successfully'));
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: true },
    });

    // Collect events while also advancing timers to unblock waitForReset.
    const collectPromise = collect(query);
    // Advance past reset + 30s buffer
    await vi.runAllTimersAsync();
    const events = await collectPromise;

    const types = events.map((e) => e.type);
    expect(types).toContain('paused');
    expect(types).toContain('resumed');
    expect(types).toContain('turn.completed');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
  });

  it('auto-resume=false: 429+ts → paused → original error, no resumed', async () => {
    messagesCreateMock.mockImplementation(() => {
      throw make429UsageLimitError(5 * 60 * 1_000);
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: false },
    });

    const events = await collect(query);
    const types = events.map((e) => e.type);

    expect(types).toContain('paused');
    expect(types).not.toContain('resumed');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('abort during wait: 429+ts → paused → abort → no resumed', async () => {
    const abortController = new AbortController();
    messagesCreateMock.mockImplementation(() => {
      // Also abort the session after 429 to simulate user interruption
      return (async function* () {
        throw make429UsageLimitError(60 * 60 * 1_000); // 1h reset
      })();
    });

    // We can't easily thread an external signal into query() without more
    // wiring, so we test via the query's close() method instead — which
    // fires 'closed' abort on the internal controller.
    let callIdx = 0;
    messagesCreateMock.mockReset();
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) throw make429UsageLimitError(60 * 60 * 1_000);
      return fromArray(makeTextStream('should not reach'));
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: true },
    });

    const events: ProviderEvent[] = [];
    const collectWithAbort = async (): Promise<void> => {
      for await (const ev of query) {
        events.push(ev);
        if (ev.type === 'paused') {
          // Simulate user closing the session mid-wait
          query.close();
        }
      }
    };

    await Promise.all([
      collectWithAbort(),
      vi.runAllTimersAsync(),
    ]);

    const types = events.map((e) => e.type);
    expect(types).toContain('paused');
    expect(types).not.toContain('resumed');
    // No second API call since we aborted
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('interrupt during wait: 429+ts → paused → interrupt() → yields terminal + stays resumable (no hang, no auto-resume)', async () => {
    // Regression guard for the usage-limit interrupt path. When Ctrl+C
    // (interrupt) lands during the usage-limit wait, `turnWithRetries` returns
    // CLEANLY (not via throw — see retry-layer's `if (result === 'aborted')
    // return`), so the catch-path abort guard never fires and control reaches
    // the post-loop guard with the signal still aborted.
    //
    // Contract (fix/interrupt-mid-turn-resume): the generator must NOT
    // terminate. An earlier fix (commit c462ebd) `return`ed here to stop the
    // consumer hanging on a `next()` that never resolves — but terminating the
    // generator permanently exhausts AgentSession's shared providerIterator, so
    // every later `sendMessageStream` silently runs no turn (the "can't resume
    // after ESC" bug). The correct behavior: emit a terminal `turn.completed`
    // (so the consumer unblocks — still no hang) AND loop back to await the
    // next prompt (so the session stays usable). The interrupted turn is
    // abandoned — no `resumed`, no replay.
    //
    // Uses REAL timers because the abort short-circuits waitForReset
    // synchronously (the signal is already aborted when waitForReset re-checks).
    vi.useRealTimers();

    const prompts = createPushStream();
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) throw make429UsageLimitError(60 * 60 * 1_000); // 1h reset
      return fromArray(makeTextStream('resumed after interrupt'));
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: prompts.iterable,
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: true },
    });

    const it = (query as AsyncIterable<ProviderEvent>)[Symbol.asyncIterator]();
    await it.next(); // session.init

    // Turn 1: 429 → paused → interrupt during the wait.
    prompts.push({ content: 'hello' });
    const turn1Types: string[] = [];
    let interrupted = false;
    let r = await it.next();
    while (!r.done) {
      const ev = r.value as ProviderEvent;
      turn1Types.push(ev.type);
      if (ev.type === 'paused' && !interrupted) {
        interrupted = true;
        await query.interrupt(); // user hits Ctrl+C during the usage-limit wait
      }
      if (ev.type === 'turn.completed') break; // terminal — the consumer unblocks here
      r = await it.next();
    }

    // The interrupt unblocked the turn via a terminal event — no hang — and the
    // generator did NOT terminate (the bug terminated it here, bricking resume).
    expect(turn1Types).toContain('paused');
    expect(turn1Types).not.toContain('resumed');
    expect(r.done).toBe(false);
    expect((r.value as ProviderEvent).type).toBe('turn.completed');

    // Resumability: a fresh prompt runs a new turn. The interrupted turn was
    // abandoned (callIdx 1 = the 429); callIdx 2 is this new prompt, NOT a
    // replay — `resumed` never appeared.
    prompts.push({ content: 'next' });
    let reply = '';
    let sawTurn2 = false;
    r = await it.next();
    while (!r.done) {
      const ev = r.value as ProviderEvent;
      if (ev.type === 'delta.text') reply += ev.text;
      if (ev.type === 'turn.completed') {
        sawTurn2 = true;
        break;
      }
      r = await it.next();
    }
    expect(sawTurn2).toBe(true);
    expect(reply).toContain('resumed after interrupt');
    expect(callIdx).toBe(2);

    prompts.close();
    await it.return?.();
  }, 10_000);

  it('2h cap: 429 with resetsAt > 2h from now → error surfaces immediately, no paused/resumed', async () => {
    messagesCreateMock.mockImplementation(() => {
      throw make429UsageLimitError(3 * 60 * 60 * 1_000); // 3h reset
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: true },
    });

    const events = await collect(query);
    const types = events.map((e) => e.type);

    // 2h cap: reset too far away — no waiting, no paused card, just the error.
    expect(types).not.toContain('paused');
    expect(types).not.toContain('resumed');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('credit-exhausted: 400+credit → error surfaces immediately, no paused', async () => {
    messagesCreateMock.mockImplementation(() => {
      throw make400CreditExhaustedError();
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: true },
    });

    const events = await collect(query);
    const types = events.map((e) => e.type);

    // Credit exhausted is not an oauth-limit — it should not produce paused/resumed
    expect(types).not.toContain('paused');
    expect(types).not.toContain('resumed');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    if (events.find((e) => e.type === 'error')?.type === 'error') {
      const errEvent = events.find((e) => e.type === 'error');
      if (errEvent?.type === 'error') {
        expect((errEvent.error as Error & { status?: number }).status).toBe(400);
      }
    }
  });

  it('oauth-limit-no-ts: 429 without timestamp → paused (no resetsAt) → hot-swap → resumed', async () => {
    // Simulate: first call throws 429 with no timestamp, second succeeds after hot-swap.
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) throw make429NoTsError();
      return fromArray(makeTextStream('resumed after hot-swap'));
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: true },
    });

    const events: ProviderEvent[] = [];
    const collectWithTimers = async (): Promise<void> => {
      for await (const ev of query) {
        events.push(ev);
        if (ev.type === 'paused') {
          // Simulate an account hot-swap by advancing timer cycles.
          // waitForHotSwap polls every 30s; after one advance the mock keychain
          // has not changed, after aborting we get 'aborted'.
          // To test the hot-swap path we close the query to trigger abort
          // (we cannot inject a real new token easily in this test harness).
          query.close();
        }
      }
    };

    await Promise.all([
      collectWithTimers(),
      vi.runAllTimersAsync(),
    ]);

    const types = events.map((e) => e.type);
    // paused must be emitted with no resetsAt
    expect(types).toContain('paused');
    const pausedEvent = events.find((e) => e.type === 'paused');
    if (pausedEvent?.type === 'paused') {
      expect(pausedEvent.resetsAt).toBeUndefined();
      // autoResume must propagate through the no-timestamp path too —
      // mirrors the explicit assertion in the autoResume=false test below.
      // Without this, regressions in the no-ts branch's autoResume threading
      // (issue #1 from PR 448's prior review round) would pass CI undetected.
      expect(pausedEvent.autoResume).toBe(true);
    }
    // Aborted mid-wait — no resumed
    expect(types).not.toContain('resumed');
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('oauth-limit-no-ts auto-resume=false: 429 without timestamp → paused → original error', async () => {
    messagesCreateMock.mockImplementation(() => {
      throw make429NoTsError();
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: false },
    });

    const events = await collect(query);
    const types = events.map((e) => e.type);

    expect(types).toContain('paused');
    const pausedEvent = events.find((e) => e.type === 'paused');
    if (pausedEvent?.type === 'paused') {
      expect(pausedEvent.resetsAt).toBeUndefined();
      expect(pausedEvent.autoResume).toBe(false);
    }
    expect(types).not.toContain('resumed');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(pausedEvent).toBeDefined();
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('oauth-limit-no-ts: 429 without timestamp → paused → timer retry → resumed (no token change)', async () => {
    // Regression guard: a no-ts 429 previously waited on a hot-swap ONLY, so a
    // same-account subscription reset never resumed and the session hung
    // forever. With the poll-retry loop, the retry timer fires, the turn
    // replays, and the (now-lifted) limit lets it through — all WITHOUT any
    // keychain token change.
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) throw make429NoTsError();
      return fromArray(makeTextStream('resumed after same-account reset'));
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: true },
    });

    const collectPromise = collect(query);
    // Advance through the no-ts retry interval so the timer fires and replays.
    await vi.runAllTimersAsync();
    const events = await collectPromise;

    const types = events.map((e) => e.type);
    expect(types).toContain('paused');
    const pausedEvent = events.find((e) => e.type === 'paused');
    if (pausedEvent?.type === 'paused') {
      expect(pausedEvent.resetsAt).toBeUndefined();
      expect(pausedEvent.autoResume).toBe(true);
    }
    // KEY: resumed fires WITHOUT a hot-swap — the same-account reset is honored.
    expect(types).toContain('resumed');
    const resumedEvent = events.find((e) => e.type === 'resumed');
    if (resumedEvent?.type === 'resumed') {
      expect(resumedEvent.hotSwapped).toBe(false);
    }
    expect(types).toContain('turn.completed');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    // Exactly one paused (no resumed/paused flip-flop); two API calls.
    expect(events.filter((e) => e.type === 'paused')).toHaveLength(1);
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
  });

  it('oauth-limit-no-ts: stays paused across a failed probe, emits resumed once on success', async () => {
    // call 1: initial 429 no-ts → paused. call 2: retry timer fires, replay is
    // STILL limited (429 no-ts again) → stay paused, do NOT emit resumed. call
    // 3: limit lifted → success. The loop must emit exactly one `paused` and
    // exactly one `resumed`.
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx <= 2) throw make429NoTsError();
      return fromArray(makeTextStream('resumed on third attempt'));
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', autoResumeOnUsageLimit: true },
    });

    const collectPromise = collect(query);
    await vi.runAllTimersAsync();
    const events = await collectPromise;

    const types = events.map((e) => e.type);
    expect(events.filter((e) => e.type === 'paused')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'resumed')).toHaveLength(1);
    expect(types).toContain('turn.completed');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(messagesCreateMock).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// forceClientRefresh + reauth tests
//
// The Anthropic SDK caches `authToken` at construction time and uses it
// per-request via `Authorization: Bearer ${authToken}` — there is no in-place
// rotation hook. So when the user runs `claude /login` in another terminal
// (writing a new token into the keychain), the running session's SDK client
// must be reconstructed; rebuilding only request headers is not enough.
//
// These tests pin down that contract:
//  1. `query.reauth()` invokes `tokenRefresher` and swaps `retry._client`.
//  2. Concurrent `reauth()` calls dedup via the shared `refreshPromise`.
//  3. `reauth()` returns `null` when no `tokenRefresher` is wired (api-key
//     mode or local-server mode).
//  4. `reauth()` returns `swapped: false` when the refresher succeeds but
//     the underlying keychain token did not change.
// ---------------------------------------------------------------------------

describe('AnthropicDirectQuery — reauth() / forceClientRefresh', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    anthropicCtorMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
  });

  /**
   * Inject a custom `tokenRefresher` after the query is constructed.
   * Mirrors the pattern used by the 401-retry tests above.
   */
  function injectRefresher(
    query: unknown,
    refresher: () => Promise<Anthropic | null>,
  ): void {
    const q = query as unknown as {
      retry: { tokenRefresher?: () => Promise<Anthropic | null> };
    };
    q.retry.tokenRefresher = refresher;
  }

  it('reauth() with tokenRefresher → invokes refresher and swaps retry._client', async () => {
    const newClient = new MockAnthropic({ authToken: 'sk-ant-oat01-new' });
    const refresher = vi.fn(async (): Promise<Anthropic | null> => {
      return newClient as unknown as Anthropic;
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-old' },
    });

    injectRefresher(query, refresher);

    const initialClient = (query as unknown as { retry: { client: unknown } }).retry.client;
    expect(initialClient).not.toBe(newClient);

    const result = await query.reauth!();

    expect(refresher).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    // Result shape:
    if (result) {
      expect(typeof result.accountId).toBe('string');
      expect(typeof result.swapped).toBe('boolean');
    }
    // Critically: the retry layer's client is the NEW instance, not the
    // initial one. This is the bug that made hot-swap broken before —
    // headers were rebuilt but the client (with cached authToken) was not.
    const swappedClient = (query as unknown as { retry: { client: unknown } }).retry.client;
    expect(swappedClient).toBe(newClient);
    expect(swappedClient).not.toBe(initialClient);
  });

  it('reauth() with no tokenRefresher (api-key mode) → returns null', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      // api-key mode: the harness intentionally does NOT wire a tokenRefresher.
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-classic' },
    });

    // Explicitly assert no refresher was wired (sanity check on the fixture).
    const q = query as unknown as { retry: { tokenRefresher?: unknown } };
    expect(q.retry.tokenRefresher).toBeUndefined();

    const result = await query.reauth!();
    expect(result).toBeNull();
  });

  it('reauth() when refresher returns null → returns null, client unchanged', async () => {
    const refresher = vi.fn(async (): Promise<Anthropic | null> => null);

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    injectRefresher(query, refresher);
    const initialClient = (query as unknown as { retry: { client: unknown } }).retry.client;

    const result = await query.reauth!();

    expect(refresher).toHaveBeenCalledOnce();
    expect(result).toBeNull();
    // Client should NOT have been swapped — refresher returned null.
    const afterClient = (query as unknown as { retry: { client: unknown } }).retry.client;
    expect(afterClient).toBe(initialClient);
  });

  it('reauth() when refresher throws → returns null, no unhandled rejection', async () => {
    const refresher = vi.fn(async (): Promise<Anthropic | null> => {
      throw new Error('network down');
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    injectRefresher(query, refresher);
    const initialClient = (query as unknown as { retry: { client: unknown } }).retry.client;

    // Must not throw — the helper catches and returns null.
    const result = await query.reauth!();
    expect(result).toBeNull();
    expect(refresher).toHaveBeenCalledOnce();

    const afterClient = (query as unknown as { retry: { client: unknown } }).retry.client;
    expect(afterClient).toBe(initialClient);
  });

  it('concurrent reauth() calls dedup via refreshPromise (single upstream call)', async () => {
    let refresherCallCount = 0;
    let resolveRefresh: ((c: Anthropic | null) => void) | null = null;
    const refresher = vi.fn(async (): Promise<Anthropic | null> => {
      refresherCallCount += 1;
      return new Promise<Anthropic | null>((resolve) => {
        resolveRefresh = resolve;
      });
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('test'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    injectRefresher(query, refresher);

    // Fire two concurrent reauth() calls.
    const p1 = query.reauth!();
    const p2 = query.reauth!();

    // Both should now be parked on the same in-flight refreshPromise.
    expect(refresherCallCount).toBe(1);

    // Resolve the refresher with a fresh client.
    const newClient = new MockAnthropic({ authToken: 'sk-ant-oat01-fresh' }) as unknown as Anthropic;
    resolveRefresh!(newClient);

    const [r1, r2] = await Promise.all([p1, p2]);

    // Refresher invoked exactly once even though two callers awaited.
    expect(refresherCallCount).toBe(1);
    // Both callers got a non-null result with the same shape.
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });
});
