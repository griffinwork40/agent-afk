import { describe, it, expect, vi } from 'vitest';
import type { ToolResult } from '../tools/types.js';
import { TOOL_USE_LOOP_CAPPED } from '../providers/shared/tool-loop-cap.js';
import { STREAM_INCOMPLETE, incompleteToolResultFields } from './result.js';
import {
  isZeroOutputStreamCut,
  runWithStreamCutRetry,
  STREAM_CUT_MAX_REDISPATCH,
} from './stream-cut-retry.js';

/** The exact shape `foreground-promotion.ts` delivers for a zero-output cut. */
const zeroOutputCut = (): ToolResult => ({
  content: JSON.stringify({ status: 'failed', error: 'produced no output' }),
  isError: true,
  incomplete: true,
  incompleteReason: STREAM_INCOMPLETE,
});

const ok = (content = 'findings'): ToolResult => ({ content });

const notAborted = new AbortController().signal;

describe('isZeroOutputStreamCut', () => {
  it('matches the zero-output stream cut (isError + stream_incomplete)', () => {
    expect(isZeroOutputStreamCut(zeroOutputCut())).toBe(true);
  });

  it('does NOT match a buffered partial — it resolves succeeded, so retrying would discard salvaged findings', () => {
    // `subagent/result.ts`: a cut that streamed real text stays status:'succeeded'
    // and is annotated, so it arrives WITHOUT isError even though the stop reason
    // is stream_incomplete.
    expect(
      isZeroOutputStreamCut({
        content: 'partial findings the child really produced',
        incomplete: true,
        incompleteReason: STREAM_INCOMPLETE,
      }),
    ).toBe(false);
  });

  it('does NOT match a tool-budget cap — that is a requested ceiling, not a transport failure', () => {
    expect(
      isZeroOutputStreamCut({
        content: '{}',
        isError: true,
        incomplete: true,
        incompleteReason: TOOL_USE_LOOP_CAPPED,
      }),
    ).toBe(false);
  });

  it('does NOT match an ordinary failure with no incompleteReason', () => {
    expect(isZeroOutputStreamCut({ content: 'boom', isError: true })).toBe(false);
  });
});

describe('runWithStreamCutRetry', () => {
  it('returns a clean first result without re-dispatching', async () => {
    const dispatch = vi.fn(async () => ok());
    const result = await runWithStreamCutRetry({ dispatch, signal: notAborted, delayMs: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(ok());
  });

  it('re-dispatches a fresh fork once and returns the rescued result', async () => {
    const dispatch = vi
      .fn<(attempt: number) => Promise<ToolResult>>()
      .mockResolvedValueOnce(zeroOutputCut())
      .mockResolvedValueOnce(ok('rescued'));
    const onRedispatch = vi.fn();

    const result = await runWithStreamCutRetry({
      dispatch,
      signal: notAborted,
      delayMs: 0,
      onRedispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('rescued');
    expect(result.isError).toBeUndefined();
    expect(onRedispatch).toHaveBeenCalledWith(1);
  });

  it('passes a 0-based attempt index to dispatch so each attempt forks fresh', async () => {
    const seen: number[] = [];
    const dispatch = vi.fn(async (attempt: number) => {
      seen.push(attempt);
      return zeroOutputCut();
    });
    await runWithStreamCutRetry({ dispatch, signal: notAborted, delayMs: 0 });
    expect(seen).toEqual([0, 1]);
  });

  it('stops at the budget and returns the final failure unchanged (purely additive)', async () => {
    const dispatch = vi.fn(async () => zeroOutputCut());
    const result = await runWithStreamCutRetry({ dispatch, signal: notAborted, delayMs: 0 });
    // 1 initial + STREAM_CUT_MAX_REDISPATCH re-dispatches.
    expect(dispatch).toHaveBeenCalledTimes(1 + STREAM_CUT_MAX_REDISPATCH);
    expect(result).toEqual(zeroOutputCut());
  });

  it('honours an explicit maxRedispatch budget', async () => {
    const dispatch = vi.fn(async () => zeroOutputCut());
    await runWithStreamCutRetry({ dispatch, signal: notAborted, delayMs: 0, maxRedispatch: 3 });
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it('maxRedispatch 0 disables the retry entirely', async () => {
    const dispatch = vi.fn(async () => zeroOutputCut());
    await runWithStreamCutRetry({ dispatch, signal: notAborted, delayMs: 0, maxRedispatch: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-dispatch when the parent turn is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const dispatch = vi.fn(async () => zeroOutputCut());
    const onRedispatch = vi.fn();

    const result = await runWithStreamCutRetry({
      dispatch,
      signal: controller.signal,
      delayMs: 0,
      onRedispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(onRedispatch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('does not fork when the abort lands DURING the settle delay', async () => {
    const controller = new AbortController();
    const dispatch = vi.fn(async () => zeroOutputCut());

    setTimeout(() => controller.abort(), 5);
    const promise = runWithStreamCutRetry({
      dispatch,
      signal: controller.signal,
      delayMs: 50,
    });

    const result = await promise;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
  });

  it('does not retry a non-retriable failure', async () => {
    const dispatch = vi.fn(async () => ({ content: 'boom', isError: true }) as ToolResult);
    await runWithStreamCutRetry({ dispatch, signal: notAborted, delayMs: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  describe('canRedispatch safety gate', () => {
    it('suppresses the retry when the gate returns false (e.g. a write-capable child)', async () => {
      const dispatch = vi.fn(async () => zeroOutputCut());
      const onRedispatch = vi.fn();

      const result = await runWithStreamCutRetry({
        dispatch,
        signal: notAborted,
        delayMs: 0,
        canRedispatch: () => false,
        onRedispatch,
      });

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(onRedispatch).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });

    it('allows the retry when the gate returns true', async () => {
      const dispatch = vi
        .fn<(attempt: number) => Promise<ToolResult>>()
        .mockResolvedValueOnce(zeroOutputCut())
        .mockResolvedValueOnce(ok('rescued'));

      const result = await runWithStreamCutRetry({
        dispatch,
        signal: notAborted,
        delayMs: 0,
        canRedispatch: () => true,
      });

      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(result.content).toBe('rescued');
    });

    it('re-checks the gate AFTER the settle delay, so a mid-wait change is honoured', async () => {
      let allowed = true;
      const dispatch = vi.fn(async () => zeroOutputCut());

      setTimeout(() => { allowed = false; }, 5);
      await runWithStreamCutRetry({
        dispatch,
        signal: notAborted,
        delayMs: 20,
        canRedispatch: () => allowed,
      });

      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Anti-drift: the predicate keys on fields produced by the REAL
 * `incompleteToolResultFields` helper. If that helper's shape ever changes, the
 * hand-rolled fixtures above would keep passing while production silently stops
 * matching — so assert against the genuine producer here.
 */
describe('isZeroOutputStreamCut against the real incompleteToolResultFields', () => {
  it('matches a failure carrying the helper output for a zero-output cut', () => {
    const produced: ToolResult = {
      content: '{}',
      isError: true,
      ...incompleteToolResultFields(STREAM_INCOMPLETE),
    };
    expect(produced.incompleteReason).toBe(STREAM_INCOMPLETE);
    expect(isZeroOutputStreamCut(produced)).toBe(true);
  });

  it('does not match the helper output for a tool-budget cap', () => {
    expect(
      isZeroOutputStreamCut({
        content: '{}',
        isError: true,
        ...incompleteToolResultFields(TOOL_USE_LOOP_CAPPED),
      }),
    ).toBe(false);
  });

  it('does not match when the helper emits nothing (a clean stop reason)', () => {
    expect(
      isZeroOutputStreamCut({
        content: '{}',
        isError: true,
        ...incompleteToolResultFields('end_turn'),
      }),
    ).toBe(false);
  });
});
