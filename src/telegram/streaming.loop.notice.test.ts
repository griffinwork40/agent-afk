/**
 * Tests for model-fallback notice handling in processInlineEvent (#4940).
 *
 * Covers:
 *  - F1: dropped notice logs via debugLog (no silent swallow)
 *  - F2: undefined route is logged, notice is not sent
 *  - F4: delivered notice is logged via debugLog
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDebugLog = vi.hoisted(() => vi.fn());
vi.mock('../utils/debug.js', () => ({ debugLog: mockDebugLog }));

import { processInlineEvent } from './streaming.loop.js';
import type { StreamState } from './streaming.handlers.js';
import type { ContentRunState } from './streaming.loop.js';
import type { Context } from 'telegraf';

function makeState(): StreamState {
  return {
    accumulated: '',
    answerText: '',
    sentMessage: null,
    sawTerminalEvent: false,
    progressEntries: [],
  } as unknown as StreamState;
}

function makeRun(): ContentRunState {
  return { contentRunStartAccumulated: 0, contentRunStartAnswer: 0, inContentRun: false };
}

function makeCtx(chatId: number | undefined): Context {
  const sendMessage = vi.fn().mockResolvedValue({});
  return {
    chat: chatId !== undefined ? { id: chatId } : undefined,
    message: chatId !== undefined ? { chat: { id: chatId }, message_thread_id: undefined } : undefined,
    telegram: { sendMessage },
  } as unknown as Context;
}

const livePreview = () => 'preview';

beforeEach(() => { mockDebugLog.mockClear(); });

describe('processInlineEvent — model-fallback notice', () => {
  it('F4: logs delivery when route resolves', async () => {
    const ctx = makeCtx(999);
    const event = { type: 'notice' as const, kind: 'model-fallback' as const, text: 'Switched to claude-haiku' };
    await processInlineEvent(event, makeState(), makeRun(), ctx, 999, livePreview);
    expect(mockDebugLog).toHaveBeenCalledWith(
      expect.stringContaining('model-fallback notice delivered'),
      expect.any(Number),
      expect.any(String),
      'Switched to claude-haiku',
    );
  });

  it('F2: logs and skips send when routeFromCtx returns undefined', async () => {
    // ctx with no chat → routeFromCtx returns undefined
    const ctx = makeCtx(undefined);
    const event = { type: 'notice' as const, kind: 'model-fallback' as const, text: 'Switched to gpt-4o' };
    await processInlineEvent(event, makeState(), makeRun(), ctx, 0, livePreview);
    expect(mockDebugLog).toHaveBeenCalledWith(
      expect.stringContaining('routeFromCtx returned undefined'),
      expect.any(String),
    );
    // telegram.sendMessage must NOT have been called
    expect((ctx.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('F1: logs when sendMessage rejects (dropped notice)', async () => {
    const ctx = makeCtx(777);
    const sendErr = new Error('network error');
    (ctx.telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(sendErr);
    const event = { type: 'notice' as const, kind: 'model-fallback' as const, text: 'Switched to fallback' };
    // Should not throw
    await expect(
      processInlineEvent(event, makeState(), makeRun(), ctx, 777, livePreview),
    ).resolves.toBe(false);
    expect(mockDebugLog).toHaveBeenCalledWith(
      expect.stringContaining('send failed'),
      sendErr,
    );
  });

  it('returns false in all cases', async () => {
    const ctx = makeCtx(123);
    const event = { type: 'notice' as const, kind: 'model-fallback' as const, text: 'x' };
    const result = await processInlineEvent(event, makeState(), makeRun(), ctx, 123, livePreview);
    expect(result).toBe(false);
  });
});
