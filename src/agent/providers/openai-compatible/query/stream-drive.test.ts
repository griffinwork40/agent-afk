/**
 * Tests for driveStream's zero-output stream-incomplete guard.
 *
 * A stream that ends cleanly (no throw) having produced NO content and NO
 * terminal finish_reason must surface an error rather than a silent empty turn
 * (the OpenAI-compatible analog of the anthropic-direct silent-truncation fix).
 *
 * Critically, the guard must NOT false-positive on the common case where a
 * local shim (MLX / llama.cpp) completes a real turn but omits finish_reason —
 * that turn HAS content, so it must still resolve as a clean completion.
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
});
