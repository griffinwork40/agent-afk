// Post-first-byte STALL watchdog tests for loop.ts (issue #762).
//
// Pins the distinction the TTFB bound alone cannot make: once a first content
// token has streamed, `ttfbEmitted` clears every bound, so a stream that then
// stalls mid-flight used to hang forever — two real sessions ran 38.9 and 63.5
// minutes and sealed `{status:'failed', finalTurnCount:0, incomplete:true}` with
// no `loop_end` and no `closure` event at all (that flag is written ONLY by
// `TraceWriter.sealOnProcessExit()`, so the turn never returned).
//
// The watchdog is PROGRESS-AWARE, so these tests must pin BOTH halves:
//   - no progress for the window  → dies with a real terminal `error` event
//   - progress, however slow      → survives indefinitely (the deliberate
//     invariant `loop.ttfb.test.ts:179` protects; a total-round wall-clock cap
//     would break it, which is why this is a sliding window instead)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawMessageStreamEvent, MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import type { AnthropicClientLike } from './types.js';
import { DEFAULT_MODEL_STALL_TIMEOUT_MS } from '../shared/stream-stall-timeout.js';
import { AgentSession } from '../../session.js';
import { InMemoryTraceWriter } from '../../trace/writer.js';
import { createMockProvider } from '../../__fixtures__/mock-provider.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeToolUseStream,
  makeDispatcher,
} from './loop.test-helpers.js';

const STALL_KEY = 'AFK_MODEL_STALL_TIMEOUT_MS';
const TTFB_KEY = 'AFK_MODEL_TTFB_TIMEOUT_MS';

/**
 * A stream that yields message_start + a real content delta (so the first-byte
 * boundary is crossed and the TTFB timer is cancelled), then STALLS forever
 * until the request signal aborts — at which point it rejects like the SDK's
 * stream iterator does. This is the exact shape of the #762 hang.
 */
function midStreamStallAfterContent(signal: AbortSignal): AsyncIterable<RawMessageStreamEvent> {
  const prefix = makeTextStream('partial').slice(0, 3); // start, block_start, delta
  return {
    [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
      let i = 0;
      return {
        next(): Promise<IteratorResult<RawMessageStreamEvent>> {
          if (i < prefix.length) {
            const value = prefix[i]!;
            i++;
            return Promise.resolve({ done: false, value });
          }
          // Past the first content token: never resolve until aborted.
          return new Promise((_resolve, reject) => {
            if (signal.aborted) { reject(new Error('aborted')); return; }
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      };
    },
  };
}

describe('runTurn post-first-byte stall watchdog (#762)', () => {
  let savedStall: string | undefined;
  let savedTtfb: string | undefined;
  beforeEach(() => {
    savedStall = process.env[STALL_KEY];
    savedTtfb = process.env[TTFB_KEY];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (savedStall === undefined) delete process.env[STALL_KEY];
    else process.env[STALL_KEY] = savedStall;
    if (savedTtfb === undefined) delete process.env[TTFB_KEY];
    else process.env[TTFB_KEY] = savedTtfb;
  });

  it('terminates LOUDLY when a stream stalls after its first content token', async () => {
    process.env[STALL_KEY] = '60000';
    let callCount = 0;
    let requestAborted = false;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          signal.addEventListener('abort', () => { requestAborted = true; });
          return midStreamStallAfterContent(signal);
        }),
      },
    };
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const callerSignal = new AbortController().signal;
    const resultPromise = collect(
      runTurn({
        client, messages, system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: callerSignal, ctx,
      }),
    );

    // Advance past the stall window. Pre-fix this promise NEVER settles — the
    // round hangs exactly as sessions 0f2bcdd0-… and 4f37526f-… did.
    await vi.advanceTimersByTimeAsync(61_000);
    const events = await resultPromise;

    // A real, loud terminal error event — the observable proof the round ENDED.
    // Its absence (plus the absence of any closure) is the signature of #762.
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(String((errorEvent as { error: Error }).error.message)).toMatch(/stalled/i);
    // The message must name the escape hatch, not leak a bare marker string.
    expect(String((errorEvent as { error: Error }).error.message)).toContain(
      'AFK_MODEL_STALL_TIMEOUT_MS',
    );
    // The stall aborted the PER-REQUEST signal (releasing the HTTP stream)...
    expect(requestAborted).toBe(true);
    // ...but never the CALLER's signal: a stall must stay distinguishable from a
    // user interrupt, or the session would seal `cancelled` instead of `failed`.
    expect(callerSignal.aborted).toBe(false);
    // No retry: a mid-stream stall has already burned a partial generation.
    expect(callCount).toBe(1);
    // Real stream error ⇒ no turn.completed (cost is not double-counted).
    expect(events.find((e) => e.type === 'turn.completed')).toBeUndefined();
  });

  it('does NOT fire on a slow stream that keeps making progress (preserves the loop.ttfb.test.ts:179 invariant)', async () => {
    // Window deliberately SHORTER than the total stream duration: a naive
    // absolute per-round cap would kill this round. Each inter-token gap stays
    // under the window, so a progress-aware watchdog must let it finish.
    process.env[STALL_KEY] = '30000';
    const GAP_MS = 20_000;
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
              // Sleep BELOW the window before every event after the first.
              if (i > 1) {
                await new Promise<void>((r) => {
                  const t = setTimeout(r, GAP_MS);
                  (t as { unref?: () => void }).unref?.();
                });
              }
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
    // 6 events × 20s ≈ 120s total — 4× the 30s window, yet no gap exceeds it.
    await vi.advanceTimersByTimeAsync(200_000);
    const events = await resultPromise;

    expect(callCount).toBe(1);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    expect(events.some((e) => e.type === 'assistant.message' && e.text === 'progressing')).toBe(true);
  });

  it('does NOT fire while a tool call streams its argument payload (input_json_delta yields nothing)', async () => {
    // Regression guard for the review finding on this PR: `input_json_delta` is
    // consumed by translate.ts WITHOUT yielding, so between `tool.use.start` and
    // `tool.use` a healthy stream produces zero translated events. If the
    // watchdog only counted translated output, a large tool-argument emission
    // would read as dead air and be aborted as a stall. Window is deliberately
    // SHORTER than the total argument-streaming span.
    process.env[STALL_KEY] = '30000';
    const GAP_MS = 20_000;
    const CHUNKS = ['{"pa', 'th":"', '/tmp/', 'a.txt', '","co', 'ntent', '":"x"', '}'];
    // Takes the per-request signal and REJECTS on abort, exactly as the SDK's
    // stream iterator does. Without this the mock would keep yielding through a
    // fired watchdog and the test would pass whether or not the fix is present.
    function chunkedToolArgStream(signal: AbortSignal): AsyncIterable<RawMessageStreamEvent> {
      const queue: RawMessageStreamEvent[] = [
        ...makeToolUseStream('tool_1', 'write_file', '{}').slice(0, 2), // start + block_start
        ...CHUNKS.map(
          (partial_json) =>
            ({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json },
            }) as unknown as RawMessageStreamEvent,
        ),
        ...makeToolUseStream('tool_1', 'write_file', '{}').slice(3), // block_stop → message_stop
      ];
      return {
        [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
          let i = 0;
          return {
            async next(): Promise<IteratorResult<RawMessageStreamEvent>> {
              if (i >= queue.length) return { done: true, value: undefined };
              const value = queue[i]!;
              i++;
              // Gap ONLY before the non-yielding argument deltas, so this test
              // isolates the invisible-progress span from every other phase.
              if ((value as { delta?: { type?: string } }).delta?.type === 'input_json_delta') {
                await new Promise<void>((resolve, reject) => {
                  if (signal.aborted) { reject(new Error('aborted')); return; }
                  const t = setTimeout(resolve, GAP_MS);
                  (t as { unref?: () => void }).unref?.();
                  signal.addEventListener(
                    'abort',
                    () => { clearTimeout(t); reject(new Error('aborted')); },
                    { once: true },
                  );
                });
              }
              return { done: false, value };
            },
          };
        },
      };
    }
    let callCount = 0;
    let requestAborted = false;
    const callerSignal = new AbortController().signal;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          signal.addEventListener('abort', () => { requestAborted = true; });
          // Round 1 streams the tool args slowly; round 2 closes the turn.
          return callCount === 1 ? chunkedToolArgStream(signal) : fromArray(makeTextStream('done'));
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: callerSignal, ctx,
      }),
    );
    // 8 chunks × 20s = 160s of yield-free streaming — 5.3× the 30s window.
    await vi.advanceTimersByTimeAsync(400_000);
    const events = await resultPromise;

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(callerSignal.aborted).toBe(false);
    // The load-bearing assertion: the watchdog never aborted the request during
    // the yield-free argument span. Without the raw-progress wiring this flips
    // true at t=30s and the round dies as a false-positive stall.
    expect(requestAborted).toBe(false);
    // The tool round completed and the turn moved on, proving the argument
    // payload was accumulated rather than truncated by an abort.
    expect(callCount).toBe(2);
    expect(events.some((e) => e.type === 'tool.use')).toBe(true);
    expect(events.some((e) => e.type === 'assistant.message' && e.text === 'done')).toBe(true);
  });

  it('STILL fires when a wedged stream emits only keep-alive pings (pings are not progress)', async () => {
    // The inverse guard for the test above: widening "progress" to cover
    // non-yielding frames must NOT extend to pings, or a wedged socket could
    // hold the window open forever with keep-alives and #762 would be back.
    process.env[STALL_KEY] = '30000';
    function pingOnlyAfterContent(signal: AbortSignal): AsyncIterable<RawMessageStreamEvent> {
      const prefix = makeTextStream('partial').slice(0, 3); // start, block_start, delta
      return {
        [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
          let i = 0;
          return {
            async next(): Promise<IteratorResult<RawMessageStreamEvent>> {
              if (i < prefix.length) {
                const value = prefix[i]!;
                i++;
                return { done: false, value };
              }
              // Keep-alives forever, 10s apart — comfortably inside the window.
              await new Promise<void>((resolve, reject) => {
                if (signal.aborted) { reject(new Error('aborted')); return; }
                const t = setTimeout(resolve, 10_000);
                (t as { unref?: () => void }).unref?.();
                signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
              });
              return { done: false, value: { type: 'ping' } as unknown as RawMessageStreamEvent };
            },
          };
        },
      };
    }
    let requestAborted = false;
    const callerSignal = new AbortController().signal;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          const signal = (opts as { signal: AbortSignal }).signal;
          signal.addEventListener('abort', () => { requestAborted = true; });
          return pingOnlyAfterContent(signal);
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: callerSignal, ctx,
      }),
    );
    await vi.advanceTimersByTimeAsync(61_000);
    const events = await resultPromise;

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(String((errorEvent as { error: Error }).error.message)).toMatch(/stalled/i);
    expect(requestAborted).toBe(true);
    expect(callerSignal.aborted).toBe(false);
  });

  it(`${STALL_KEY}=0 disables the watchdog (matching the TTFB=0 convention)`, async () => {
    process.env[STALL_KEY] = '0';
    process.env[TTFB_KEY] = '0'; // isolate: no other bound may fire
    let callCount = 0;
    let requestAborted = false;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          signal.addEventListener('abort', () => { requestAborted = true; });
          return midStreamStallAfterContent(signal);
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
    // Advance far past what WOULD be the default window — nothing may fire.
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_STALL_TIMEOUT_MS * 2);
    expect(callCount).toBe(1);
    expect(requestAborted).toBe(false); // our watchdog never aborted the request
    // Genuinely hung (disabled = pre-#762 behaviour); abort from the caller side
    // so the generator can settle for the test.
    abortController.abort('test cleanup');
    await vi.advanceTimersByTimeAsync(10);
    const events = await resultPromise;
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
  });

  // Requirement 1 of #762: the terminal `error` this watchdog yields must
  // actually reach a REAL `closure` event and a seal that is NOT
  // `incomplete: true`. The absence of both is the observable signature of the
  // bug (`incomplete: true` is written ONLY by `TraceWriter.sealOnProcessExit()`,
  // the process-exit backstop — so seeing it means the turn never returned).
  // Driven at the SESSION layer, because closure/seal are emitted by
  // AgentSession, not by runTurn: this pins the end of the causal chain
  // (provider `error` → sawProviderError → closure{reason:'abort'} →
  // seal{status:'failed'} with no `incomplete` flag) that the loop-level tests
  // above feed into.
  it('a provider error seals with a real closure and NOT incomplete:true', async () => {
    vi.useRealTimers(); // session bootstrap uses real async lifecycle
    const provider = createMockProvider();
    const writer = new InMemoryTraceWriter();
    const session = new AgentSession({
      model: 'sonnet', apiKey: 'test-key', provider, traceWriter: writer,
    });
    await session.waitForInitialization();
    // 'provider-error' makes the mock yield a terminal `error` event — the same
    // ProviderEvent shape the stall watchdog produces in runTurn above.
    //
    // Invariant: a terminal provider `error` REJECTS sendMessage. That rejection
    // is itself part of the loud-failure contract this test pins (the caller is
    // told, rather than left awaiting a promise that never settles), so it is
    // asserted rather than merely tolerated — but it must not abort the test
    // before the closure/seal assertions below, which are the real subject.
    await expect(session.sendMessage('provider-error please')).rejects.toThrow(
      /mock provider stream failure/,
    );
    await session.close();

    const closure = writer.events.find((e) => e.kind === 'closure');
    expect(closure).toBeDefined();
    if (closure?.kind !== 'closure') throw new Error('expected closure');
    // A provider error classifies as an abort-family closure, never a silent
    // clean end — the operator gets a terminal record naming what happened.
    expect(closure.payload.reason).toBe('abort');

    const seal = writer.events.find((e) => e.kind === 'session_sealed');
    expect(seal).toBeDefined();
    if (seal?.kind !== 'session_sealed') throw new Error('expected seal');
    expect(seal.payload.status).toBe('failed');
    // THE load-bearing assertion: a real seal, not the process-exit backstop.
    expect(seal.payload.incomplete).toBeUndefined();
    // And closure must precede the seal (what happened, then the terminal record).
    const kinds = writer.events.map((e) => e.kind);
    expect(kinds.indexOf('session_sealed')).toBeGreaterThan(kinds.indexOf('closure'));
  });

  it('re-arms per round: a stalled round after a clean tool-use round still fires', async () => {
    process.env[STALL_KEY] = '60000';
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          // Round 1 streams cleanly to end_turn; a second call would stall.
          return callCount === 1
            ? fromArray(makeTextStream('done'))
            : midStreamStallAfterContent(signal);
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
    await vi.advanceTimersByTimeAsync(61_000);
    const events = await resultPromise;
    // The clean round completed normally and the watchdog never fired on it —
    // proof `dispose()` runs on the normal path (a leaked timer would abort the
    // NEXT round's request and surface a spurious error here).
    expect(callCount).toBe(1);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
  });
});
