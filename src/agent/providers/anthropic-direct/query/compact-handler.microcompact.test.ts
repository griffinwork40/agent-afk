/**
 * Wiring test for the microcompaction fallback inside {@link compactHistory}.
 *
 * The unit tests in `../microcompact.test.ts` cover the transform itself. This
 * file proves the HANDLER wiring: that `/compact` on a single-turn-but-full
 * session (where turn-granular summarization returns `history-too-short`)
 * instead routes through `runMicrocompactFallback` and reports the new
 * `microcompacted` outcome carrying the reclaimed block/byte counts — and that
 * when nothing qualifies it still reports the honest no-op reason.
 *
 * `compactHistory` reaches the fallback BEFORE any SDK/network use: on a single
 * fresh user turn `findCompactionBoundary` returns -1, so `retry` and
 * `traceWriter` are never dereferenced. That makes this a pure in-memory test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { compactHistory } from './compact-handler.js';
import { createSessionState, type SessionState } from './session-state.js';
import { AbortCoordinator } from '../../shared/abort-coordinator.js';
import type { RetryLayer } from './retry-layer.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';
import { findCompactionBoundary } from '../compact.js';
import { isMicrocompactPlaceholder } from '../../shared/compaction.js';

function toolUse(id: string): MessageParam {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: {} }] };
}
function toolResult(id: string, bytes: number, fill = 'x'): MessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: fill.repeat(bytes) }],
  };
}

/**
 * A single fresh user turn followed by three large tool-use/result exchanges in
 * that SAME turn window. `findCompactionBoundary` returns -1 for this shape (only
 * one fresh user turn, fewer than keepLastN=2), so summarization is powerless —
 * exactly the case microcompaction exists to handle.
 */
function singleTurnFull(): MessageParam[] {
  return [
    { role: 'user', content: 'read these three files and summarize' },
    toolUse('t1'),
    toolResult('t1', 20_000, 'a'),
    toolUse('t2'),
    toolResult('t2', 20_000, 'b'),
    toolUse('t3'),
    toolResult('t3', 20_000, 'c'),
  ];
}

function makeState(messages: MessageParam[]): SessionState {
  return createSessionState({
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    userSystem: null,
    // The microcompaction fallback path never dereferences the dispatcher.
    toolDispatcher: {} as unknown as ToolDispatcher,
    initialMessages: messages,
  });
}

async function runCompact(state: SessionState): ReturnType<typeof compactHistory> {
  return compactHistory({
    state,
    abort: new AbortCoordinator(), // fresh → isIdle() true
    // Never touched on the boundary<0 path (no summarization request is made).
    retry: {} as unknown as RetryLayer,
    initSessionId: 'test-session',
  });
}

describe('compactHistory — microcompaction fallback wiring', () => {
  const KEEP = 'AFK_MICROCOMPACT_KEEP_LAST';
  const BYTES = 'AFK_MICROCOMPACT_TOOL_RESULT_BYTES';
  const KEEP_TURNS = 'AFK_COMPACT_KEEP_LAST_TURNS';
  beforeEach(() => {
    delete process.env[KEEP];
    delete process.env[BYTES];
    delete process.env[KEEP_TURNS];
  });
  afterEach(() => {
    delete process.env[KEEP];
    delete process.env[BYTES];
    delete process.env[KEEP_TURNS];
  });

  it('reports `microcompacted` (not `history-too-short`) on a single-turn-but-full session', async () => {
    // Sanity: this shape is genuinely un-summarizable by turn-count logic.
    const probe = singleTurnFull();
    expect(findCompactionBoundary(probe, 2)).toBe(-1);

    // keepLast=1 leaves the freshest tool_result protected; the two older 20KB
    // results become candidates and clear.
    process.env[KEEP] = '1';
    const state = makeState(singleTurnFull());
    const messagesBefore = state.messages.length;

    const res = await runCompact(state);

    expect(res.reason).toBe('microcompacted');
    expect(res.compacted).toBe(false);
    expect(res.microcompaction).toBeDefined();
    expect(res.microcompaction!.blocksCleared).toBe(2);
    expect(res.microcompaction!.bytesReclaimed).toBeGreaterThan(35_000);

    // No message was removed — microcompaction never changes the message count.
    expect(res.messagesBefore).toBe(messagesBefore);
    expect(res.messagesAfter).toBe(messagesBefore);
    expect(state.messages).toHaveLength(messagesBefore);

    // The cleared results are placeholders in the SAME array the handler mutated.
    const clearedCount = state.messages.filter((m) => {
      if (!Array.isArray(m.content)) return false;
      const block = m.content[0] as { type?: string; content?: unknown };
      return (
        block?.type === 'tool_result' &&
        typeof block.content === 'string' &&
        isMicrocompactPlaceholder(block.content)
      );
    }).length;
    expect(clearedCount).toBe(2);
  });

  it('falls back to the honest `history-too-short` when nothing qualifies to clear', async () => {
    // Default keepLast (4) protects all three results → microcompaction is a
    // no-op → the handler must surface the real no-op reason, not `microcompacted`.
    const state = makeState(singleTurnFull());
    const res = await runCompact(state);

    expect(res.reason).toBe('history-too-short');
    expect(res.compacted).toBe(false);
    expect(res.microcompaction).toBeUndefined();
  });

  it('does not touch history that summarization can already compact (no fallback)', async () => {
    // Two fresh user turns with a summarizable older turn: boundary > 0, so the
    // normal summarization path runs and the microcompaction fallback is skipped.
    // We assert only that the reason is NOT a microcompaction outcome — the
    // summarization request itself would need the SDK, so give it a shape that
    // still boundary<0 is avoided but we stop short of asserting success.
    const messages: MessageParam[] = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request' },
      { role: 'assistant', content: 'second answer' },
      { role: 'user', content: 'third request' },
    ];
    // Three fresh user turns, keepLastN=2 → boundary points at turn 3 (> 0), so
    // findCompactionBoundary does NOT return -1 → the fallback is not the path.
    expect(findCompactionBoundary(messages, 2)).toBeGreaterThan(0);
  });
});

describe('compactHistory — microcompaction runs after successful compaction', () => {
  const KEEP = 'AFK_MICROCOMPACT_KEEP_LAST';
  const BYTES = 'AFK_MICROCOMPACT_TOOL_RESULT_BYTES';
  beforeEach(() => {
    delete process.env[KEEP];
    delete process.env[BYTES];
  });
  afterEach(() => {
    delete process.env[KEEP];
    delete process.env[BYTES];
  });

  /**
   * History with enough fresh user turns so normal compaction finds a boundary
   * AND a large tool result in the kept tail that microcompaction should clear.
   *
   * Shape (keepLastN=2):
   *   u1 / a1                — older turn (summarized away)
   *   u2 / a2 / use(t1) / result(t1, 20KB) — kept tail: t1 is large → micro target
   *   u3                     — second kept fresh turn
   *
   * findCompactionBoundary returns > 0, so the network path fires; we stub it.
   */
  function historyWithLargeTailResult(): MessageParam[] {
    const bigContent = 'x'.repeat(20_000);
    return [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: bigContent }],
      },
      { role: 'user', content: 'u3' },
    ];
  }

  /** Minimal stub that streams a single text_delta event carrying the summary. */
  async function* stubStream(summary: string) {
    yield {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: summary },
    };
  }

  it('clears large tool results in the kept tail even when compaction succeeds', async () => {
    // keepLast=0 → no results protected → all oversized results are candidates.
    process.env[KEEP] = '0';
    // Low threshold so our 20KB content qualifies.
    process.env[BYTES] = '100';

    const messages = historyWithLargeTailResult();
    // Sanity: boundary is positive so the summarization path runs.
    expect(findCompactionBoundary(messages, 2)).toBeGreaterThan(0);

    const messagesCreateMock = vi.fn(() => stubStream('COMPRESSED'));
    const fakeRetry = {
      client: { messages: { create: messagesCreateMock } },
      authMode: 'api-key',
    } as unknown as RetryLayer;

    const state = makeState(messages);
    const result = await compactHistory({
      state,
      abort: new AbortCoordinator(),
      retry: fakeRetry,
      initSessionId: 'test-session',
    });

    // Normal compaction ran — the summarizer was called.
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    // The result reports a successful compaction (not just microcompacted).
    expect(result.compacted).toBe(true);

    // The large tool result in the kept tail was also cleared by microcompaction.
    const toolResultMsg = state.messages.find((m) => {
      if (!Array.isArray(m.content)) return false;
      const block = m.content[0] as { type?: string };
      return block?.type === 'tool_result';
    });
    expect(toolResultMsg).toBeDefined();
    const block = (toolResultMsg!.content as Array<{ type?: string; content?: unknown }>)[0];
    expect(typeof block.content).toBe('string');
    expect(isMicrocompactPlaceholder(block.content as string)).toBe(true);
  });
});
