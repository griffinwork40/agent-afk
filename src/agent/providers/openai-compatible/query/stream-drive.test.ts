/**
 * Tests for driveStream's stream-incomplete guard.
 *
 * A stream that ends cleanly (no throw) with NO terminal finish_reason and NO
 * DISPATCHABLE response must surface an error rather than a silent empty turn
 * (the OpenAI-compatible analog of the anthropic-direct silent-truncation fix).
 * "No dispatchable response" covers three truncation shapes, all exercised
 * below: truly-empty streams, reasoning-only cut-offs (reasoning deltas but no
 * visible answer), and non-dispatchable partial tool calls (a call missing its
 * id or name).
 *
 * Critically, the guard must NOT false-positive on the common case where a
 * local shim (MLX / llama.cpp) completes a real turn but omits finish_reason —
 * a turn that produced VISIBLE TEXT or a DISPATCHABLE tool call must still
 * resolve as a clean completion.
 */

import { describe, it, expect } from 'vitest';
import {
  driveStream,
  type StreamDriveContext,
  type StreamDriveStrategy,
  type IterationResult,
} from './stream-drive.js';
import type { ProviderEvent } from '../../../provider.js';
import type { StreamState } from '../translate.js';

function makeCtx(): StreamDriveContext {
  return {
    controller: new AbortController(),
    traceWriter: undefined,
    initSessionId: 'sess-test',
    currentModel: 'test-model',
    isClosed: () => false,
  };
}

async function drive<T>(
  ctx: StreamDriveContext,
  strategy: StreamDriveStrategy<T>,
): Promise<{ events: ProviderEvent[]; result: IterationResult | null }> {
  const gen = driveStream(ctx, strategy);
  const events: ProviderEvent[] = [];
  let result: IterationResult | null = null;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    events.push(step.value);
  }
  return { events, result };
}

describe('driveStream — zero-output stream-incomplete guard', () => {
  it('surfaces an error when the stream ends with no output and no finish_reason', async () => {
    // Empty stream: connection opens, yields zero chunks, ends without throwing.
    const strategy: StreamDriveStrategy<unknown> = {
      createStream: async () =>
        (async function* (): AsyncIterable<unknown> {
          /* yields nothing */
        })(),
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const { events, result } = await drive(makeCtx(), strategy);

    // No silent clean completion.
    expect(result).toBeNull();
    // An error event was surfaced.
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
    const err = errs[0];
    if (!err || err.type !== 'error') throw new Error('expected an error event');
    expect(err.error).toBeInstanceOf(Error);
    expect(err.error.message).toMatch(/finish_reason|output|incomplete|empty|cut off/i);
  });

  it('does NOT flag a clean end that produced text but omitted finish_reason (shim-safe)', async () => {
    // Some OpenAI-compatible shims (MLX / llama.cpp) complete a real turn without
    // sending finish_reason. That turn HAS content and must resolve normally —
    // the guard must not treat it as incomplete.
    const strategy: StreamDriveStrategy<{ text: string }> = {
      createStream: async () =>
        (async function* (): AsyncIterable<{ text: string }> {
          yield { text: 'a complete answer' };
        })(),
      translate: (event, state: StreamState) => {
        state.assistantText += event.text;
        return [];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const { events, result } = await drive(makeCtx(), strategy);

    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(0);
    expect(result).not.toBeNull();
    expect(result?.text).toBe('a complete answer');
    expect(result?.needsToolDispatch).toBe(false);
  });

  it('surfaces an error on a reasoning-only cut-off (reasoning deltas, no answer, no finish_reason)', async () => {
    // A reasoning model streams reasoning deltas, then the connection is cut off
    // before any visible answer and before finish_reason. reasoningText is
    // non-empty but there is no dispatchable response — the pre-fix zero-output
    // guard (which also required reasoningText.length === 0) let this through as a
    // silent empty success. It must now fail loudly.
    const strategy: StreamDriveStrategy<{ reasoning: string }> = {
      createStream: async () =>
        (async function* (): AsyncIterable<{ reasoning: string }> {
          yield { reasoning: 'let me work through this step by step...' };
        })(),
      translate: (event, state: StreamState) => {
        state.reasoningText += event.reasoning;
        return [];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const { events, result } = await drive(makeCtx(), strategy);

    expect(result).toBeNull();
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
    const err = errs[0];
    if (!err || err.type !== 'error') throw new Error('expected an error event');
    expect(err.error).toBeInstanceOf(Error);
    expect(err.error.message).toMatch(/finish_reason|output|incomplete|dispatchable|cut off/i);
  });

  it('surfaces an error on a non-dispatchable partial tool call (no name, no finish_reason)', async () => {
    // A tool-call stream cut off mid-delta: the accumulated call has an id but the
    // name never arrived, so isToolCallStop() is false and needsToolDispatch is
    // false. With no finish_reason and no visible answer, the pre-fix guard (which
    // required toolCallsByIndex.size === 0) let this through as a silent empty
    // success. It must now fail loudly.
    const strategy: StreamDriveStrategy<{ index: number; id: string }> = {
      createStream: async () =>
        (async function* (): AsyncIterable<{ index: number; id: string }> {
          yield { index: 0, id: 'call_abc123' };
        })(),
      translate: (event, state: StreamState) => {
        state.toolCallsByIndex.set(event.index, {
          index: event.index,
          id: event.id,
          name: '', // name never arrived → non-dispatchable partial call
          argumentsRaw: '',
          startEmitted: false,
        });
        return [];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const { events, result } = await drive(makeCtx(), strategy);

    expect(result).toBeNull();
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
    const err = errs[0];
    if (!err || err.type !== 'error') throw new Error('expected an error event');
    expect(err.error).toBeInstanceOf(Error);
  });

  it('does NOT flag a dispatchable tool call that omitted finish_reason (shim-safe)', async () => {
    // A shim completes a real tool-call turn (complete id + name) but omits
    // finish_reason. isToolCallStop()'s no-finish_reason fallback treats it as a
    // tool stop, so needsToolDispatch is true — it must resolve as a clean
    // completion, guarding against over-broadening the incomplete-stream guard.
    const strategy: StreamDriveStrategy<{
      index: number;
      id: string;
      name: string;
      args: string;
    }> = {
      createStream: async () =>
        (async function* () {
          yield { index: 0, id: 'call_abc123', name: 'get_weather', args: '{"city":"NYC"}' };
        })(),
      translate: (event, state: StreamState) => {
        state.toolCallsByIndex.set(event.index, {
          index: event.index,
          id: event.id,
          name: event.name,
          argumentsRaw: event.args,
          startEmitted: false,
        });
        return [];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const { events, result } = await drive(makeCtx(), strategy);

    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(0);
    expect(result).not.toBeNull();
    expect(result?.needsToolDispatch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Interrupt-halt parity with anthropic-direct (the ESC-lag fix, ported).
//
// Two mechanisms of the interrupt-lag bug are exercised here:
//   1. PROMPT halt — each stream pull is raced against the turn signal
//      (abortableStream), so an ESC interrupt settles the iteration within the
//      current event-loop turn instead of waiting for a parked SSE read.
//   2. SINGLE terminal — an interrupted turn must NOT yield a spurious `error`
//      event. This wire is the sharper case: openai@6's SSE iterator SWALLOWS a
//      mid-stream abort and ends its `for await` CLEANLY (streaming.mjs
//      `if (isAbortError(e)) return;`). Pre-fix, that clean end fell through to
//      the stream-incomplete guard and yielded a StreamIncompleteError alongside
//      the caller's turn.completed — the double-terminal that strands the next
//      turn. abortableStream throws promptly on abort (surfacing as a caught
//      throw → clean null return), and a belt-and-suspenders abort check guards
//      the incomplete-stream branch.
// ---------------------------------------------------------------------------

/** A source whose `next()` never resolves — models a parked SSE read. */
function parkedStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise<IteratorResult<unknown>>(() => {
            /* never resolves — the read is parked awaiting the next SSE frame */
          });
        },
      };
    },
  };
}

/**
 * A source that models the OpenAI SDK's swallow-on-abort behaviour: the parked
 * read RESOLVES `{done:true}` (rather than rejecting) the instant the signal
 * fires — exactly what `Stream.fromSSEResponse` does via `if (isAbortError(e))
 * return;`. Yields nothing before the abort → an empty-turn interrupt, the shape
 * that pre-fix tripped the stream-incomplete guard.
 */
function sdkSwallowOnAbortStream(signal: AbortSignal): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise<IteratorResult<unknown>>((resolve) => {
            if (signal.aborted) {
              resolve({ value: undefined, done: true });
              return;
            }
            signal.addEventListener(
              'abort',
              () => resolve({ value: undefined, done: true }),
              { once: true },
            );
          });
        },
      };
    },
  };
}

describe('driveStream — interrupt halt (ESC-lag parity)', () => {
  it('halts PROMPTLY when the signal aborts while a read is parked (no hang)', async () => {
    // Without the per-pull abort race this would hang forever on the parked
    // read. The abort must win the race and settle the generator on the next
    // microtasks — driveStream returns null (no clean completion, no error).
    const ctx = makeCtx();
    const strategy: StreamDriveStrategy<unknown> = {
      createStream: async () => parkedStream(),
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const gen = driveStream(ctx, strategy);
    const events: ProviderEvent[] = [];
    const drained = (async () => {
      let step = await gen.next();
      while (!step.done) {
        events.push(step.value);
        step = await gen.next();
      }
      return step.value;
    })();

    // Interrupt while parked. If the pull were not raced, `drained` never
    // resolves and the test times out (the bug).
    ctx.controller.abort('interrupted');
    const result = await drained;

    expect(result).toBeNull();
    // An interrupt is not a failure: no error event may be emitted.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('yields NO spurious error on an interrupt the SDK swallows (single-terminal regression)', async () => {
    // Pre-fix repro: openai@6 swallows a mid-stream abort and ends the for-await
    // cleanly, so an empty-turn interrupt fell through to the stream-incomplete
    // guard and emitted a StreamIncompleteError. Because the caller ALSO emits
    // turn.completed on abort, that produced TWO terminal-ish events — the
    // stranded-terminal bug. The fix must return a clean null with no error.
    const ctx = makeCtx();
    const strategy: StreamDriveStrategy<unknown> = {
      createStream: async (signal) => sdkSwallowOnAbortStream(signal),
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const gen = driveStream(ctx, strategy);
    const events: ProviderEvent[] = [];
    const drained = (async () => {
      let step = await gen.next();
      while (!step.done) {
        events.push(step.value);
        step = await gen.next();
      }
      return step.value;
    })();

    ctx.controller.abort('interrupted');
    const result = await drained;

    // Clean abort return — the caller (query.ts) owns the single turn.completed.
    expect(result).toBeNull();
    // The load-bearing assertion: an interrupt must not surface as an `error`
    // (a StreamIncompleteError here would strand the trailing turn.completed).
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('still surfaces the incomplete-stream error on a genuine empty completion (not aborted)', async () => {
    // Guard against over-correction: the abort short-circuit must NOT suppress
    // the real silent-truncation guard when the signal is NOT aborted. An empty
    // stream that ends cleanly with no finish_reason is still a loud error.
    const ctx = makeCtx();
    const strategy: StreamDriveStrategy<unknown> = {
      createStream: async () =>
        (async function* (): AsyncIterable<unknown> {
          /* yields nothing, ends cleanly, signal never aborts */
        })(),
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const { events, result } = await drive(ctx, strategy);

    expect(result).toBeNull();
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });
});
