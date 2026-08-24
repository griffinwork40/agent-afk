/**
 * Tests for the Telegram streaming sender helpers.
 *
 * Covers:
 * - sendOrEdit: throttle gate, first-send, HTML→plaintext fallback, 429 retry
 * - deliverClean: multi-chunk delivery, flood-control 429 retry, truncation notice
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramError } from 'telegraf';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import {
  DELIVERY_TRUNCATED_NOTICE,
  EDIT_THROTTLE_MS,
  deliverClean,
  sendOrEdit,
  type SenderState,
} from './streaming.sender.js';

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Telegraf Context mock that tracks replies and edits.
 * `ctx.reply()` returns a Message.TextMessage stub with a monotonically
 * incrementing message_id so tests can exercise the "edit an existing message"
 * branch of sendOrEdit.
 */
function makeCtx(): {
  ctx: Context;
  replies: Array<{ text: string; parseMode: string | undefined }>;
  edits: Array<{ text: string; parseMode: string | undefined }>;
} {
  const replies: Array<{ text: string; parseMode: string | undefined }> = [];
  const edits: Array<{ text: string; parseMode: string | undefined }> = [];
  let msgId = 0;

  const ctx = {
    chat: { id: 42, type: 'private' as const },
    reply: vi.fn(async (text: string, extra?: { parse_mode?: string }) => {
      replies.push({ text, parseMode: extra?.parse_mode });
      msgId++;
      return {
        message_id: msgId,
        text,
        chat: { id: 42, type: 'private' as const },
        date: 0,
      } as Message.TextMessage;
    }),
    telegram: {
      editMessageText: vi.fn(
        async (
          _chatId: unknown,
          _msgId: unknown,
          _inlineId: unknown,
          text: string,
          extra?: { parse_mode?: string },
        ) => {
          edits.push({ text, parseMode: extra?.parse_mode });
          return true;
        },
      ),
    },
  } as unknown as Context;

  return { ctx, replies, edits };
}

/** Build a fresh SenderState with sentMessage=null and lastEditAt=0. */
function makeSenderState(overrides: Partial<SenderState> = {}): SenderState {
  return { sentMessage: null, lastEditAt: 0, ...overrides };
}

/** A TelegramError simulating Telegram's entity-parse failure (400). */
function makeParseError(): TelegramError {
  return new TelegramError({
    error_code: 400,
    description: "Bad Request: can't parse entities: unexpected end tag",
  });
}

/** A TelegramError simulating a flood-control 429 with a retry_after. */
function make429(retryAfterSecs = 1): TelegramError {
  return new TelegramError({
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfterSecs}`,
    parameters: { retry_after: retryAfterSecs },
  });
}

// ---------------------------------------------------------------------------
// sendOrEdit — first send
// ---------------------------------------------------------------------------

describe('sendOrEdit — first send (sentMessage is null)', () => {
  it('calls ctx.reply with HTML parse_mode on the first call', async () => {
    const { ctx, replies } = makeCtx();
    const state = makeSenderState();
    await sendOrEdit(state, ctx, 42, 'Hello world');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.parseMode).toBe('HTML');
    expect(state.sentMessage).not.toBeNull();
  });

  it('stores sentMessage after first send', async () => {
    const { ctx } = makeCtx();
    const state = makeSenderState();
    expect(state.sentMessage).toBeNull();
    await sendOrEdit(state, ctx, 42, 'first message');
    expect(state.sentMessage).not.toBeNull();
    expect(state.sentMessage!.message_id).toBe(1);
  });

  it('uses the fallback placeholder "…" when text is empty', async () => {
    const { ctx, replies } = makeCtx();
    const state = makeSenderState();
    await sendOrEdit(state, ctx, 42, '');
    expect(replies[0]!.text).toBeDefined();
    // The HTML conversion of '…' via markdownToTelegramHtml is still non-empty.
    expect(replies[0]!.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// sendOrEdit — HTML→plaintext fallback on first send
// ---------------------------------------------------------------------------

describe('sendOrEdit — HTML→plaintext fallback on entity parse error (first send)', () => {
  it('retries without parse_mode when ctx.reply throws a 400 entity-parse error', async () => {
    const { ctx, replies } = makeCtx();
    const parseErr = makeParseError();
    let htmlAttempts = 0;

    // First HTML attempt fails; subsequent plain-text attempt succeeds.
    (ctx.reply as ReturnType<typeof vi.fn>).mockImplementation(
      async (text: string, extra?: { parse_mode?: string }) => {
        if (extra?.parse_mode === 'HTML') {
          htmlAttempts++;
          throw parseErr;
        }
        replies.push({ text, parseMode: extra?.parse_mode });
        return {
          message_id: 1,
          text,
          chat: { id: 42, type: 'private' as const },
          date: 0,
        } as Message.TextMessage;
      },
    );

    const state = makeSenderState();
    await sendOrEdit(state, ctx, 42, 'some **text**');
    expect(htmlAttempts).toBe(1);
    // The fallback plain-text reply must have been sent.
    expect(replies).toHaveLength(1);
    expect(replies[0]!.parseMode).toBeUndefined();
    expect(state.sentMessage).not.toBeNull();
  });

  it('rethrows non-parse errors from the first send', async () => {
    const { ctx } = makeCtx();
    const networkErr = new TelegramError({
      error_code: 500,
      description: 'Internal Server Error',
    });
    (ctx.reply as ReturnType<typeof vi.fn>).mockRejectedValue(networkErr);
    const state = makeSenderState();
    await expect(sendOrEdit(state, ctx, 42, 'text')).rejects.toBe(networkErr);
  });
});

// ---------------------------------------------------------------------------
// sendOrEdit — throttle gate
// ---------------------------------------------------------------------------

describe('sendOrEdit — throttle gate (edit path)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('skips an edit when within EDIT_THROTTLE_MS and text is short', async () => {
    const { ctx, replies, edits } = makeCtx();
    // Establish sentMessage via the first send.
    const state = makeSenderState();
    await sendOrEdit(state, ctx, 42, 'initial text');
    const beforeEdits = edits.length;

    // Set lastEditAt to "now" (fake time = 0), then try to edit with short text.
    state.lastEditAt = Date.now();
    await sendOrEdit(state, ctx, 42, 'x', false); // short text (<100 chars), not forced

    // The throttle must have suppressed the edit.
    expect(edits.length).toBe(beforeEdits);
    expect(replies.length).toBe(1); // no second reply either
  });

  it('allows an edit after EDIT_THROTTLE_MS has elapsed', async () => {
    const { ctx, edits } = makeCtx();
    const state = makeSenderState();
    await sendOrEdit(state, ctx, 42, 'initial');
    state.lastEditAt = Date.now();

    // Advance past the throttle window.
    await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS + 1);

    await sendOrEdit(state, ctx, 42, 'updated text');
    expect(edits.length).toBe(1);
  });

  it('allows an edit regardless of throttle when force=true', async () => {
    const { ctx, edits } = makeCtx();
    const state = makeSenderState();
    await sendOrEdit(state, ctx, 42, 'initial');
    state.lastEditAt = Date.now(); // reset to "just edited"

    // Force-edit without waiting.
    await sendOrEdit(state, ctx, 42, 'forced update', true);
    expect(edits.length).toBe(1);
  });

  it('allows an edit when text is long (≥100 chars) even within throttle window', async () => {
    const { ctx, edits } = makeCtx();
    const state = makeSenderState();
    await sendOrEdit(state, ctx, 42, 'initial');
    state.lastEditAt = Date.now();

    const longText = 'a'.repeat(100);
    await sendOrEdit(state, ctx, 42, longText, false);
    expect(edits.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sendOrEdit — HTML→plaintext fallback on edit
// ---------------------------------------------------------------------------

describe('sendOrEdit — HTML→plaintext fallback on entity parse error (edit)', () => {
  it('retries editMessageText without parse_mode on a 400 entity-parse error', async () => {
    const { ctx, edits } = makeCtx();
    const parseErr = makeParseError();
    let htmlEdits = 0;

    (ctx.telegram.editMessageText as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _cId: unknown,
        _mId: unknown,
        _iId: unknown,
        text: string,
        extra?: { parse_mode?: string },
      ) => {
        if (extra?.parse_mode === 'HTML') {
          htmlEdits++;
          throw parseErr;
        }
        edits.push({ text, parseMode: extra?.parse_mode });
        return true;
      },
    );

    // Establish sentMessage first.
    const state = makeSenderState();
    await sendOrEdit(state, ctx, 42, 'initial text');
    // Reset lastEditAt so the next call is not throttled.
    state.lastEditAt = 0;

    await sendOrEdit(state, ctx, 42, 'updated **text**', true);
    expect(htmlEdits).toBeGreaterThanOrEqual(1);
    // The plain-text fallback edit was recorded.
    const plainEdits = edits.filter((e) => e.parseMode === undefined);
    expect(plainEdits.length).toBeGreaterThanOrEqual(1);
  });

  it('silently swallows errors when the plain-text fallback also fails', async () => {
    const { ctx } = makeCtx();
    const parseErr = makeParseError();
    const plainErr = new TelegramError({
      error_code: 400,
      description: 'Bad Request: message is not modified',
    });

    (ctx.telegram.editMessageText as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cId: unknown, _mId: unknown, _iId: unknown, _text: string, extra?: { parse_mode?: string }) => {
        if (extra?.parse_mode === 'HTML') throw parseErr;
        throw plainErr;
      },
    );

    const state = makeSenderState();
    await sendOrEdit(state, ctx, 42, 'initial');
    state.lastEditAt = 0;

    // Must not rethrow — the edit is cosmetic.
    await expect(sendOrEdit(state, ctx, 42, 'new content', true)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sendOrEdit — 429 flood-control retry on edit
// ---------------------------------------------------------------------------

describe('sendOrEdit — 429 flood-control retry on edit', () => {
  it('waits for retry_after and retries the edit on a 429', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, edits } = makeCtx();
      const flood = make429(1); // retry after 1 second
      let editAttempts = 0;

      (ctx.telegram.editMessageText as ReturnType<typeof vi.fn>).mockImplementation(
        async (
          _cId: unknown,
          _mId: unknown,
          _iId: unknown,
          text: string,
          extra?: { parse_mode?: string },
        ) => {
          editAttempts++;
          if (editAttempts === 1) throw flood;
          edits.push({ text, parseMode: extra?.parse_mode });
          return true;
        },
      );

      const state = makeSenderState();
      // Establish sentMessage so we reach the edit path.
      await sendOrEdit(state, ctx, 42, 'initial');
      state.lastEditAt = 0; // clear throttle

      // Kick off the edit — it will hit the 429, sleep, then retry.
      const editPromise = sendOrEdit(state, ctx, 42, 'updated', true);
      // Advance past the retry_after (1s = 1000ms).
      await vi.advanceTimersByTimeAsync(1100);
      await editPromise;

      // The retry must have landed.
      expect(editAttempts).toBe(2);
      expect(edits.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('ignores the retry when a newer edit landed during the sleep', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, edits } = makeCtx();
      const flood = make429(1);
      let editAttempts = 0;

      (ctx.telegram.editMessageText as ReturnType<typeof vi.fn>).mockImplementation(
        async (_cId: unknown, _mId: unknown, _iId: unknown, text: string, extra?: { parse_mode?: string }) => {
          editAttempts++;
          if (editAttempts === 1) throw flood;
          edits.push({ text, parseMode: extra?.parse_mode });
          return true;
        },
      );

      const state = makeSenderState();
      await sendOrEdit(state, ctx, 42, 'initial');
      const preSleepLastEdit = Date.now();
      state.lastEditAt = preSleepLastEdit;

      const editPromise = sendOrEdit(state, ctx, 42, 'content-before-sleep', true);

      // Simulate a newer edit arriving WHILE we're sleeping (bumps lastEditAt).
      await vi.advanceTimersByTimeAsync(500);
      state.lastEditAt = preSleepLastEdit + 1; // different → "newer edit landed"

      await vi.advanceTimersByTimeAsync(600);
      await editPromise;

      // Only the initial attempt (which 429'd) was made; the retry was skipped
      // because lastEditAt changed during the sleep.
      expect(editAttempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// deliverClean — multi-chunk delivery
// ---------------------------------------------------------------------------

describe('deliverClean — multi-chunk delivery', () => {
  it('delivers a single short chunk via ctx.reply with HTML parse_mode', async () => {
    const { ctx, replies } = makeCtx();
    const delivered = await deliverClean(ctx, 'Short answer.');
    expect(delivered).toBe(true);
    expect(replies.some((r) => r.parseMode === 'HTML')).toBe(true);
  });

  it('returns false and delivers nothing for an empty string', async () => {
    const { ctx, replies } = makeCtx();
    const delivered = await deliverClean(ctx, '');
    expect(delivered).toBe(false);
    expect(replies).toHaveLength(0);
  });

  it('delivers multiple chunks when the text exceeds the 4096-char Telegram limit', async () => {
    const { ctx, replies } = makeCtx();
    // Build two clearly separate 4100-char chunks.
    const chunk1 = 'a'.repeat(4100);
    const chunk2 = 'b'.repeat(4100);
    const longText = chunk1 + '\n' + chunk2;

    const delivered = await deliverClean(ctx, longText);
    expect(delivered).toBe(true);
    // Both chunks must have reached Telegram.
    const combined = replies.map((r) => r.text).join('');
    expect(combined).toContain('a');
    expect(combined).toContain('b');
    expect(replies.length).toBeGreaterThanOrEqual(2);
  });

  it('returns true as soon as at least one chunk lands', async () => {
    const { ctx } = makeCtx();
    const delivered = await deliverClean(ctx, 'Single sentence.');
    expect(delivered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deliverClean — HTML→plaintext fallback
// ---------------------------------------------------------------------------

describe('deliverClean — HTML→plaintext fallback on entity parse error', () => {
  it('retries the chunk as plain text when HTML send throws 400 entity-parse error', async () => {
    const { ctx, replies } = makeCtx();
    const parseErr = makeParseError();
    let htmlReplies = 0;

    (ctx.reply as ReturnType<typeof vi.fn>).mockImplementation(
      async (text: string, extra?: { parse_mode?: string }) => {
        if (extra?.parse_mode === 'HTML') {
          htmlReplies++;
          throw parseErr;
        }
        replies.push({ text, parseMode: extra?.parse_mode });
        return {
          message_id: htmlReplies + 1,
          text,
          chat: { id: 42, type: 'private' as const },
          date: 0,
        } as Message.TextMessage;
      },
    );

    const delivered = await deliverClean(ctx, 'some text with **markdown**');
    expect(htmlReplies).toBeGreaterThanOrEqual(1);
    // Fallback plain-text reply must have landed.
    expect(replies.some((r) => r.parseMode === undefined)).toBe(true);
    expect(delivered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deliverClean — flood-control 429 retry
// ---------------------------------------------------------------------------

describe('deliverClean — flood-control 429 retry', () => {
  it('retries a 429 and eventually succeeds', async () => {
    const { ctx, replies } = makeCtx();
    let callCount = 0;

    (ctx.reply as ReturnType<typeof vi.fn>).mockImplementation(
      async (text: string, extra?: { parse_mode?: string }) => {
        callCount++;
        if (callCount === 1) throw make429(0); // 0s → DEFAULT_FLOOD_BACKOFF_MS (1s)
        replies.push({ text, parseMode: extra?.parse_mode });
        return {
          message_id: callCount,
          text,
          chat: { id: 42, type: 'private' as const },
          date: 0,
        } as Message.TextMessage;
      },
    );

    const delivered = await deliverClean(ctx, 'hello');
    expect(callCount).toBe(2);
    expect(delivered).toBe(true);
    expect(replies).toHaveLength(1);
  });

  it('posts the DELIVERY_TRUNCATED_NOTICE and returns when a non-parse TelegramError persists', async () => {
    const { ctx, replies } = makeCtx();
    const chunk1 = 'a'.repeat(4100);
    const chunk2 = 'b'.repeat(4100);
    const longText = chunk1 + '\n' + chunk2;

    const transportErr = new TelegramError({
      error_code: 400,
      description: 'Bad Request: message is too long',
    });

    let htmlReplies = 0;
    (ctx.reply as ReturnType<typeof vi.fn>).mockImplementation(
      async (text: string, extra?: { parse_mode?: string }) => {
        if (extra?.parse_mode === 'HTML') {
          htmlReplies++;
          // First HTML chunk succeeds, second fails with a non-parse error.
          if (htmlReplies >= 2) throw transportErr;
        }
        replies.push({ text, parseMode: extra?.parse_mode });
        return {
          message_id: replies.length,
          text,
          chat: { id: 42, type: 'private' as const },
          date: 0,
        } as Message.TextMessage;
      },
    );

    // deliverClean must not rethrow; it catches and posts a notice.
    const delivered = await deliverClean(ctx, longText);

    // The first chunk landed (delivered=true).
    expect(delivered).toBe(true);
    // The truncation notice was posted.
    expect(replies.some((r) => r.text === DELIVERY_TRUNCATED_NOTICE)).toBe(true);
  });

  it('DELIVERY_TRUNCATED_NOTICE constant is non-empty and includes a rate-limit message', () => {
    expect(DELIVERY_TRUNCATED_NOTICE.length).toBeGreaterThan(0);
    expect(DELIVERY_TRUNCATED_NOTICE).toContain('rate limit');
  });
});

// ---------------------------------------------------------------------------
// deliverClean — rethrows non-TelegramError (unexpected errors must propagate)
// ---------------------------------------------------------------------------

describe('deliverClean — non-TelegramError propagation', () => {
  it('rethrows unexpected non-TelegramError exceptions', async () => {
    const { ctx } = makeCtx();
    const networkErr = new Error('Network connection lost');
    (ctx.reply as ReturnType<typeof vi.fn>).mockRejectedValue(networkErr);

    await expect(deliverClean(ctx, 'text')).rejects.toBe(networkErr);
  });
});
