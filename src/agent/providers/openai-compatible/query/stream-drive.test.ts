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
