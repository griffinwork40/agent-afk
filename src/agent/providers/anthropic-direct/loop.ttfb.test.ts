// Time-to-first-byte (TTFB) stall-timeout tests for loop.ts (issue #583).
//
// Pins the per-request first-byte bound: a call that streams NO first event
// within the per-ATTEMPT bound is aborted and re-driven while the round's
// counted TTFB budget holds allowance, then surfaces as an error — instead of
// hanging up to the SDK's ~10-min default. A stream that DOES yield a first byte
// within the bound is unaffected (even if it then runs long), and setting the
// bound to 0 disables the mechanism entirely.
//
// Invariant: AFK_MODEL_TTFB_TIMEOUT_MS is the per-ROUND budget, divided into
// TTFB_MAX_ATTEMPTS shorter attempts (ttfbAttemptTimeoutMs). Tests therefore
// advance by ATTEMPT_MS per stalled attempt, not by the configured value.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawMessageStreamEvent, MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import type { AnthropicClientLike } from './types.js';
import { DEFAULT_MODEL_TTFB_TIMEOUT_MS } from '../shared/first-byte-timeout.js';
import {
  TTFB_LEGACY_ATTEMPTS,
  TTFB_MAX_ATTEMPTS,
  ttfbAttemptTimeoutMs,
} from './loop/retry-budget.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeDispatcher,
} from './loop.test-helpers.js';

const KEY = 'AFK_MODEL_TTFB_TIMEOUT_MS';

/** Per-attempt bound at the default per-round budget, + slack to fire it. */
const ATTEMPT_MS = ttfbAttemptTimeoutMs(DEFAULT_MODEL_TTFB_TIMEOUT_MS) + 1_000;

// A stream that emits message_start, then STALLS before any content event
// until the request signal aborts — at which point it throws an AbortError,
// exactly like the SDK's stream iterator does. Models a post-headers stall.
function postHeaderStallStream(signal: AbortSignal): AsyncIterable<RawMessageStreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
      let sentStart = false;
      return {
        next(): Promise<IteratorResult<RawMessageStreamEvent>> {
          if (!sentStart) {
            sentStart = true;
            return Promise.resolve({
              done: false,
              value: {
                type: 'message_start',
                message: {
                  id: 'msg_stall', type: 'message', role: 'assistant', content: [],
                  model: 'claude-test', stop_reason: null, stop_sequence: null,
                  usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                },
              } as unknown as RawMessageStreamEvent,
            });
          }
          // Second pull: never resolves until the (linked TTFB) signal aborts.
          return new Promise((_resolve, reject) => {
            if (signal.aborted) { reject(new Error('aborted')); return; }
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      };
    },
  };
}

// A messages.create() promise that NEVER resolves until the request signal
// aborts, then rejects — models a connection-phase stall (no response headers).
function connectionStall(signal: AbortSignal): Promise<AsyncIterable<RawMessageStreamEvent>> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

describe('runTurn TTFB stall timeout (#583)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('aborts a post-headers stall at the bound, retries once, then succeeds', async () => {
    process.env[KEY] = '180000';
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          // First call stalls after headers; retry streams a normal response.
          return callCount === 1
            ? postHeaderStallStream(signal)
            : fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const resultPromise = collect(
      runTurn({
        client, messages, system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );

    // Advance PAST the 180s bound so the stall timer fires and the retry runs.
    await vi.advanceTimersByTimeAsync(ATTEMPT_MS);
    const events = await resultPromise;

    expect(callCount).toBe(2); // original + one retry
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    // Exactly one stream.retry marker so surfaces clear the stalled attempt.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
    // The recovered assistant text made it through.
    expect(events.some((e) => e.type === 'assistant.message' && e.text === 'recovered')).toBe(true);
  });

  it('aborts a connection-phase stall at the bound and retries once', async () => {
    process.env[KEY] = '180000';
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          return callCount === 1 ? connectionStall(signal) : fromArray(makeTextStream('ok'));
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );
    await vi.advanceTimersByTimeAsync(ATTEMPT_MS);
    const events = await resultPromise;

    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
  });

  it('surfaces an error (not a hang) once the counted TTFB budget is exhausted', async () => {
    process.env[KEY] = '180000';
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          return postHeaderStallStream(signal); // always stalls
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );
    // Every attempt stalls: advance past one per-attempt bound per attempt.
    for (let i = 0; i < TTFB_MAX_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(ATTEMPT_MS);
    }
    const events = await resultPromise;

    // Exactly TTFB_MAX_ATTEMPTS calls, then a real error — the budget is a
    // CEILING, not an invitation to retry forever.
    expect(callCount).toBe(TTFB_MAX_ATTEMPTS);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    // One retry marker per re-drive (attempts - 1), all before the error.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(
      TTFB_MAX_ATTEMPTS - 1,
    );
  });

  // Regression (counted TTFB budget): the measured failure mode. A real child
  // sub-agent made ~25 model round trips, 4 of which stalled to the TTFB bound
  // at a ≈16% per-request stall rate. Under the pre-count boolean this exact
  // shape — TWO consecutive stalls on one round — exhausted the single re-drive
  // and killed the turn with an `error`. It must now RECOVER on attempt 3.
  //
  // This is the test that fails without the fix: with `ttfbRetried` as a boolean
  // callCount stops at 2 and an `error` event is emitted instead of the text.
  it('recovers from TWO consecutive first-byte stalls — the case the boolean lost', async () => {
    process.env[KEY] = '180000';
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          // Attempts 1 and 2 stall; attempt 3 streams normally.
          return callCount <= TTFB_LEGACY_ATTEMPTS
            ? postHeaderStallStream(signal)
            : fromArray(makeTextStream('recovered-after-two-stalls'));
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );
    // One per-attempt bound per stalled attempt.
    await vi.advanceTimersByTimeAsync(ATTEMPT_MS);
    await vi.advanceTimersByTimeAsync(ATTEMPT_MS);
    const events = await resultPromise;

    // Three attempts: two stalls survived, third succeeded.
    expect(callCount).toBe(TTFB_MAX_ATTEMPTS);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    // One stream.retry per re-drive so surfaces clear BOTH stalled attempts.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(2);
    expect(
      events.some(
        (e) => e.type === 'assistant.message' && e.text === 'recovered-after-two-stalls',
      ),
    ).toBe(true);
  });

  // Worst-case wall time is the whole point of the trade: more attempts must not
  // buy a longer round. Measured on the fake clock, this pins the end-to-end
  // budget — not just the arithmetic in retry-budget.test.ts — so a future change
  // that re-lengthens the per-attempt bound fails here too.
  it('exhausts its whole budget in no more wall time than the pre-count regime', async () => {
    process.env[KEY] = '180000';
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          return postHeaderStallStream((opts as { signal: AbortSignal }).signal);
        }),
      },
    };
    const startedAt = Date.now();
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );
    for (let i = 0; i < TTFB_MAX_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(ATTEMPT_MS);
    }
    const events = await resultPromise;
    const elapsed = Date.now() - startedAt;

    // The budget really was spent (this is a worst case, not an early exit)…
    expect(callCount).toBe(TTFB_MAX_ATTEMPTS);
    expect(events.find((e) => e.type === 'error')).toBeDefined();
    // …and cost no more than the pre-count 2 × 180s = 360s worst case. The
    // `+ 1_000` slack per attempt is the test's own timer nudge, not the bound.
    const preCountWorstCaseMs = TTFB_LEGACY_ATTEMPTS * DEFAULT_MODEL_TTFB_TIMEOUT_MS;
    expect(elapsed).toBeLessThanOrEqual(preCountWorstCaseMs + TTFB_MAX_ATTEMPTS * 1_000);
  });

  it('does NOT abort a stream that yields a first byte within the bound, even if it then runs long', async () => {
    process.env[KEY] = '180000';
    // Stream that yields message_start + a content delta quickly, then a long
    // gap before the terminal events — the timer must already be cancelled by
    // the first event, so no abort/retry fires.
    function slowButProgressingStream(): AsyncIterable<RawMessageStreamEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
          const queue: RawMessageStreamEvent[] = makeTextStream('progressing');
          let i = 0;
          return {
            async next(): Promise<IteratorResult<RawMessageStreamEvent>> {
              if (i >= queue.length) return { done: true, value: undefined };
              const value = queue[i]!;
              i++;
              // After the first content delta (index 2), insert a long delay to
              // prove the (now-cancelled) timer does not fire mid-stream.
              if (i === 3) await new Promise<void>((r) => { const t = setTimeout(r, 600_000); (t as { unref?: () => void }).unref?.(); });
              return { done: false, value };
            },
          };
        },
      };
    }
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => { callCount++; return slowButProgressingStream(); }) },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );
    // Advance well past the bound AND past the mid-stream 600s gap.
    await vi.advanceTimersByTimeAsync(700_000);
    const events = await resultPromise;

    expect(callCount).toBe(1); // no retry
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    expect(events.some((e) => e.type === 'assistant.message' && e.text === 'progressing')).toBe(true);
  });

  it('AFK_MODEL_TTFB_TIMEOUT_MS=0 disables the timeout (no abort/retry on a stall)', async () => {
    process.env[KEY] = '0';
    let callCount = 0;
    let aborted = false;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          signal.addEventListener('abort', () => { aborted = true; });
          return postHeaderStallStream(signal);
        }),
      },
    };
    const abortController = new AbortController();
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: abortController.signal, ctx,
      }),
    );
    // Advance far past what WOULD be the default bound — nothing should fire.
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TTFB_TIMEOUT_MS * 4);
    // The stream is genuinely hung (disabled timeout = SDK-default behaviour),
    // so we abort from the caller side to let the generator settle for the test.
    expect(callCount).toBe(1);
    expect(aborted).toBe(false); // our TTFB timer never aborted the request
    abortController.abort('test cleanup');
    await vi.advanceTimersByTimeAsync(10);
    const events = await resultPromise;
    // Caller-abort yields a terminal turn.completed, and no retry ever happened.
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
  });
  // A TTFB re-drive must be legible in the trace as ITS OWN phase. Before the
  // split it emitted `rate_limit`, making a self-inflicted 180s stall
  // indistinguishable from provider throttling (the same phase the SDK's real
  // 429/503 backoff uses) — 5 such stalls in one pre-flight were misread that
  // way. `metadata.reason` stays 'ttfb-timeout' for pre-split analyses.
  it('emits a ttfb_timeout session_phase — not rate_limit — on the re-drive', async () => {
    process.env[KEY] = '180000';
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          return callCount === 1
            ? postHeaderStallStream(signal)
            : fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx, traceWriter: writer,
      }),
    );
    await vi.advanceTimersByTimeAsync(ATTEMPT_MS);
    await resultPromise;

    const phases = writer.events.filter((e) => e.kind === 'session_phase');
    const ttfbStalls = phases.filter(
      (e) => (e.payload as { phase: string }).phase === 'ttfb_timeout',
    );
    expect(ttfbStalls).toHaveLength(1);
    const payload = ttfbStalls[0]!.payload as {
      durationMs?: number;
      metadata?: Record<string, unknown>;
    };
    // The dead wait is recorded, and the legacy reason tag is preserved. The
    // recorded wait is now the PER-ATTEMPT bound (120s at the 180s per-round
    // budget), not the configured value — that shrink IS the fix, so assert the
    // real bound rather than the pre-count one.
    expect(payload.durationMs).toBeGreaterThanOrEqual(
      ttfbAttemptTimeoutMs(DEFAULT_MODEL_TTFB_TIMEOUT_MS),
    );
    expect(payload.durationMs).toBeLessThan(DEFAULT_MODEL_TTFB_TIMEOUT_MS);
    expect(payload.metadata?.['reason']).toBe('ttfb-timeout');
    // The counted budget makes WHICH re-drive this was observable in the trace.
    expect(payload.metadata?.['attempt']).toBe(1);
    // The conflated phase is gone: no rate_limit was emitted for OUR watchdog.
    expect(
      phases.filter((e) => (e.payload as { phase: string }).phase === 'rate_limit'),
    ).toHaveLength(0);
  });
});
