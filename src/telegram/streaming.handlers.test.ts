/**
 * Tests for the Telegram streaming event handlers.
 *
 * Covers:
 * - handlePaused: countdown interval, autoResume, accountId
 * - handleResumed: clears interval, resume message
 * - handleDone: terminal flags, deliverClean vs sendOrEdit, onComplete
 * - handleError: flags, rethrows
 * - deliverOverflow: guard, overflow replies, TelegramError handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramError } from 'telegraf';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import {
  handlePaused,
  handleResumed,
  handleDone,
  handleError,
  deliverOverflow,
  PAUSE_COUNTDOWN_INTERVAL_MS,
  type StreamState,
  type HandlerParams,
} from './streaming.handlers.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./streaming.sender.js', () => ({
  sendOrEdit: vi.fn(async () => {}),
  deliverClean: vi.fn(async () => true),
  replyWithFloodRetryImpl: vi.fn(async () => {}),
  splitLongMessage: vi.fn((text: string) => [text]),
  DELIVERY_TRUNCATED_NOTICE: '⚠️ Message truncated due to rate limit.',
}));
vi.mock('./streaming.retry.js', () => ({
  replyWithFloodRetry: vi.fn(async () => {}),
}));
vi.mock('./formatter.js', () => ({
  splitLongMessage: vi.fn((text: string) => [text]),
  markdownToTelegramHtml: vi.fn((text: string) => text),
}));

import { sendOrEdit, deliverClean } from './streaming.sender.js';
import { replyWithFloodRetry as replyWithFloodRetryImpl } from './streaming.retry.js';
import { splitLongMessage } from './formatter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): Context {
  return {
    chat: { id: 42, type: 'private' as const },
    reply: vi.fn(async () => ({ message_id: 1, text: '', chat: { id: 42 }, date: 0 })),
    telegram: {
      editMessageText: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({ message_id: 2, text: '', chat: { id: 42 }, date: 0 })),
    },
  } as unknown as Context;
}

function makeState(overrides: Partial<StreamState> = {}): StreamState {
  return {
    sentMessage: null, lastEditAt: 0, accumulated: '', answerText: '',
    pausedUntil: null, countdownInterval: null, editInFlight: false,
    lastCountdownBucket: -1, sawTerminalEvent: false, progressEntries: [],
    progressRounds: 0, turnEnded: false, progressTimer: null,
    turnStartedAt: Date.now(), ...overrides,
  };
}

function makeParams(ctx: Context, state: StreamState, overrides: Partial<HandlerParams> = {}): HandlerParams {
  return {
    state, ctx, chatId: 42, cleanFinal: false,
    livePreview: () => state.accumulated,
    finalBody: () => state.accumulated,
    clearProgressTimer: vi.fn(),
    renderActivityReceipt: vi.fn(() => ''),
    onComplete: undefined, logger: vi.fn(), ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handlePaused
// ---------------------------------------------------------------------------

describe('handlePaused', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(sendOrEdit).mockResolvedValue(undefined); });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('sends pause message with reset time when resetsAt provided', async () => {
    const state = makeState();
    const resetsAt = new Date(Date.now() + 60 * 60 * 1_000);
    await handlePaused({ resetsAt, autoResume: true }, makeParams(makeCtx(), state));
    const msg = vi.mocked(sendOrEdit).mock.calls[0]![3] as string;
    expect(msg).toContain('Usage paused');
    expect(msg).toContain('Resets at');
  });

  it('uses "send again" copy when autoResume=false', async () => {
    const state = makeState();
    const resetsAt = new Date(Date.now() + 30 * 60 * 1_000);
    await handlePaused({ resetsAt, autoResume: false }, makeParams(makeCtx(), state));
    expect(vi.mocked(sendOrEdit).mock.calls[0]![3]).toContain('send again');
  });

  it('appends Account line when accountId provided', async () => {
    const state = makeState();
    await handlePaused({ accountId: 'alice@example.com', autoResume: true }, makeParams(makeCtx(), state));
    expect(vi.mocked(sendOrEdit).mock.calls[0]![3]).toContain('Account: alice@example.com');
  });

  it('arms countdown interval only when pausedUntil !== null and autoResume=true', async () => {
    const state = makeState();
    const resetsAt = new Date(Date.now() + 60 * 60 * 1_000);
    await handlePaused({ resetsAt, autoResume: true }, makeParams(makeCtx(), state));
    expect(state.countdownInterval).not.toBeNull();
  });

  it('does NOT arm interval when autoResume=false', async () => {
    const state = makeState();
    await handlePaused({ resetsAt: new Date(Date.now() + 3600_000), autoResume: false }, makeParams(makeCtx(), state));
    expect(state.countdownInterval).toBeNull();
  });

  it('does NOT arm interval when resetsAt is null', async () => {
    const state = makeState();
    await handlePaused({ resetsAt: null, autoResume: true }, makeParams(makeCtx(), state));
    expect(state.countdownInterval).toBeNull();
  });

  it('interval skips edit when editInFlight=true', async () => {
    const state = makeState();
    await handlePaused({ resetsAt: new Date(Date.now() + 120 * 60_000), autoResume: true }, makeParams(makeCtx(), state));
    vi.mocked(sendOrEdit).mockClear();
    state.editInFlight = true;
    await vi.advanceTimersByTimeAsync(PAUSE_COUNTDOWN_INTERVAL_MS + 1);
    expect(sendOrEdit).not.toHaveBeenCalled();
  });

  it('interval skips edit when bucket unchanged', async () => {
    const state = makeState();
    await handlePaused({ resetsAt: new Date(Date.now() + 120 * 60_000), autoResume: true }, makeParams(makeCtx(), state));
    vi.mocked(sendOrEdit).mockClear();
    // After PAUSE_COUNTDOWN_INTERVAL_MS: 120min - 5min = 115min → bucket = floor(115/5) = 23
    state.lastCountdownBucket = 23;
    await vi.advanceTimersByTimeAsync(PAUSE_COUNTDOWN_INTERVAL_MS + 1);
    expect(sendOrEdit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleResumed
// ---------------------------------------------------------------------------

describe('handleResumed', () => {
  beforeEach(() => { vi.mocked(sendOrEdit).mockResolvedValue(undefined); });
  afterEach(() => { vi.clearAllMocks(); });

  it('clears and nulls countdownInterval', async () => {
    const state = makeState({ countdownInterval: setInterval(() => {}, 9999) });
    await handleResumed({}, makeParams(makeCtx(), state));
    expect(state.countdownInterval).toBeNull();
  });

  it('nulls pausedUntil', async () => {
    const state = makeState({ pausedUntil: new Date() });
    await handleResumed({}, makeParams(makeCtx(), state));
    expect(state.pausedUntil).toBeNull();
  });

  it('sends "Resumed on X" when hotSwapped and accountId provided', async () => {
    const state = makeState();
    await handleResumed({ hotSwapped: true, accountId: 'alice@example.com' }, makeParams(makeCtx(), state));
    expect(vi.mocked(sendOrEdit).mock.calls[0]![3]).toContain('Resumed on alice@example.com');
  });

  it('sends plain "Resumed" otherwise', async () => {
    const state = makeState();
    await handleResumed({ hotSwapped: false }, makeParams(makeCtx(), state));
    const msg = vi.mocked(sendOrEdit).mock.calls[0]![3] as string;
    expect(msg).toContain('Resumed');
    expect(msg).not.toContain('on ');
  });
});

// ---------------------------------------------------------------------------
// handleDone
// ---------------------------------------------------------------------------

describe('handleDone', () => {
  beforeEach(() => {
    vi.mocked(sendOrEdit).mockResolvedValue(undefined);
    vi.mocked(deliverClean).mockResolvedValue(true);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('sets sawTerminalEvent=true and turnEnded=true', async () => {
    const state = makeState();
    await handleDone(undefined, makeParams(makeCtx(), state));
    expect(state.sawTerminalEvent).toBe(true);
    expect(state.turnEnded).toBe(true);
  });

  it('calls clearProgressTimer and clears countdownInterval', async () => {
    const state = makeState({ countdownInterval: setInterval(() => {}, 9999) });
    const clearProgressTimer = vi.fn();
    await handleDone(undefined, makeParams(makeCtx(), state, { clearProgressTimer }));
    expect(clearProgressTimer).toHaveBeenCalledOnce();
    expect(state.countdownInterval).toBeNull();
  });

  it('cleanFinal + non-empty answerText → calls deliverClean and deletes preview', async () => {
    const sentMessage = { message_id: 99, text: '', chat: { id: 42 }, date: 0 } as Message.TextMessage;
    const ctx = makeCtx();
    const state = makeState({ answerText: 'Final answer', sentMessage });
    await handleDone(undefined, makeParams(ctx, state, { cleanFinal: true }));
    expect(deliverClean).toHaveBeenCalledOnce();
    expect(ctx.telegram.deleteMessage).toHaveBeenCalledWith(42, 99);
    expect(state.sentMessage).toBeNull();
  });

  it('cleanFinal + empty answerText → falls to sendOrEdit', async () => {
    const state = makeState({ answerText: '' });
    await handleDone(undefined, makeParams(makeCtx(), state, {
      cleanFinal: true, finalBody: () => 'progress',
    }));
    expect(deliverClean).not.toHaveBeenCalled();
    expect(sendOrEdit).toHaveBeenCalledOnce();
  });

  it('non-cleanFinal → sendOrEdit with finalBody', async () => {
    const state = makeState();
    await handleDone(undefined, makeParams(makeCtx(), state, {
      cleanFinal: false, finalBody: () => 'answer body',
    }));
    expect(sendOrEdit).toHaveBeenCalledOnce();
    expect(vi.mocked(sendOrEdit).mock.calls[0]![3]).toBe('answer body');
  });

  it('calls onComplete with answerText and metadata', async () => {
    const state = makeState({ answerText: 'hello' });
    const onComplete = vi.fn(async () => {});
    const metadata = { model: 'test' } as never;
    await handleDone(metadata, makeParams(makeCtx(), state, { onComplete }));
    expect(onComplete).toHaveBeenCalledWith('hello', metadata);
  });

  it('catches onComplete errors, logs, does not rethrow', async () => {
    const state = makeState();
    const onComplete = vi.fn(async () => { throw new Error('boom'); });
    const logger = vi.fn();
    await expect(handleDone(undefined, makeParams(makeCtx(), state, { onComplete, logger }))).resolves.toBe(true);
    expect(logger).toHaveBeenCalled();
  });

  it('returns true', async () => {
    const result = await handleDone(undefined, makeParams(makeCtx(), makeState()));
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleError
// ---------------------------------------------------------------------------

describe('handleError', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('sets sawTerminalEvent=true and turnEnded=true', () => {
    const state = makeState();
    try { handleError(new Error('test'), makeParams(makeCtx(), state)); } catch {}
    expect(state.sawTerminalEvent).toBe(true);
    expect(state.turnEnded).toBe(true);
  });

  it('clears timers', () => {
    const state = makeState({ countdownInterval: setInterval(() => {}, 9999) });
    const clearProgressTimer = vi.fn();
    try { handleError(new Error('test'), makeParams(makeCtx(), state, { clearProgressTimer })); } catch {}
    expect(clearProgressTimer).toHaveBeenCalledOnce();
    expect(state.countdownInterval).toBeNull();
  });

  it('rethrows the error', () => {
    const err = new Error('streaming error');
    expect(() => handleError(err, makeParams(makeCtx(), makeState()))).toThrow(err);
  });
});

// ---------------------------------------------------------------------------
// deliverOverflow
// ---------------------------------------------------------------------------

describe('deliverOverflow', () => {
  const preview = { message_id: 1, text: '', chat: { id: 42 }, date: 0 } as Message.TextMessage;

  beforeEach(() => {
    vi.mocked(splitLongMessage).mockImplementation((t: string) => [t]);
    vi.mocked(replyWithFloodRetryImpl).mockResolvedValue(undefined);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('no-op when cleanFinal=true and answerText non-empty', async () => {
    const ctx = makeCtx();
    await deliverOverflow(ctx, true, 'answer', 'finalBody', preview);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('no-op when only 1 chunk', async () => {
    vi.mocked(splitLongMessage).mockReturnValueOnce(['single']);
    await deliverOverflow(makeCtx(), false, '', 'text', preview);
    expect(replyWithFloodRetryImpl).not.toHaveBeenCalled();
  });

  it('sends overflow chunks [1..] as replies', async () => {
    vi.mocked(splitLongMessage).mockReturnValueOnce(['c0', 'c1', 'c2']);
    await deliverOverflow(makeCtx(), false, '', 'long text', preview);
    expect(replyWithFloodRetryImpl).toHaveBeenCalledTimes(2);
  });

  it('no-op when preview is null', async () => {
    vi.mocked(splitLongMessage).mockReturnValueOnce(['c0', 'c1']);
    await deliverOverflow(makeCtx(), false, '', 'text', null);
    expect(replyWithFloodRetryImpl).not.toHaveBeenCalled();
  });

  it('catches TelegramError → replies DELIVERY_TRUNCATED_NOTICE', async () => {
    const ctx = makeCtx();
    vi.mocked(splitLongMessage).mockReturnValueOnce(['c0', 'c1']);
    vi.mocked(replyWithFloodRetryImpl).mockRejectedValueOnce(
      new TelegramError({ error_code: 429, description: 'Too Many Requests: retry after 30' }),
    );
    await deliverOverflow(ctx, false, '', 'long text', preview);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('truncated'));
  });

  it('rethrows non-TelegramError', async () => {
    vi.mocked(splitLongMessage).mockReturnValueOnce(['c0', 'c1']);
    const netErr = new Error('Network lost');
    vi.mocked(replyWithFloodRetryImpl).mockRejectedValueOnce(netErr);
    await expect(deliverOverflow(makeCtx(), false, '', 'long text', preview)).rejects.toBe(netErr);
  });
});
