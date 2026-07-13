/**
 * Unit tests for the Telegram routing primitive (src/telegram/route.ts).
 *
 * Covers the §11 leak fix: a button tap inside a topic carries its thread id on
 * callback_query.message, not ctx.message — routeFromCtx must still find it.
 */

import { describe, it, expect } from 'vitest';
import type { Context } from 'telegraf';
import { routeFromCtx, routeKey, sendOptions, isGeneral, GENERAL_TOPIC_ID } from './route.js';

/** Build a minimal ctx-like object with just the fields routeFromCtx reads. */
function ctx(parts: {
  chatId?: number;
  message?: Record<string, unknown>;
  editedMessage?: Record<string, unknown>;
  callbackMessage?: Record<string, unknown>;
}): Context {
  return {
    chat: parts.chatId === undefined ? undefined : { id: parts.chatId, type: 'private' },
    message: parts.message,
    editedMessage: parts.editedMessage,
    callbackQuery: parts.callbackMessage ? { message: parts.callbackMessage } : undefined,
  } as unknown as Context;
}

describe('routeFromCtx', () => {
  it('returns undefined when the update has no chat', () => {
    expect(routeFromCtx(ctx({}))).toBeUndefined();
  });

  it('reads chat id with no thread (General / topics-off)', () => {
    expect(routeFromCtx(ctx({ chatId: 42, message: { text: 'hi' } }))).toEqual({ chatId: 42 });
  });

  it('captures message_thread_id + is_topic_message from a text message', () => {
    const r = routeFromCtx(ctx({ chatId: 42, message: { text: 'hi', message_thread_id: 7, is_topic_message: true } }));
    expect(r).toEqual({ chatId: 42, threadId: 7, isTopicMessage: true });
  });

  it('captures the thread id from a callback_query message (button tap in a topic)', () => {
    const r = routeFromCtx(ctx({ chatId: 42, callbackMessage: { message_thread_id: 7, is_topic_message: true } }));
    expect(r).toEqual({ chatId: 42, threadId: 7, isTopicMessage: true });
  });

  it('captures the thread id from an edited message', () => {
    const r = routeFromCtx(ctx({ chatId: 42, editedMessage: { message_thread_id: 9 } }));
    expect(r).toEqual({ chatId: 42, threadId: 9 });
  });

  it('ignores a non-numeric message_thread_id', () => {
    const r = routeFromCtx(ctx({ chatId: 42, message: { message_thread_id: 'x' } }));
    expect(r).toEqual({ chatId: 42 });
  });
});

describe('isGeneral / routeKey — General normalizes to the bare chat id', () => {
  it('treats absent thread as General', () => {
    expect(isGeneral({ chatId: 42 })).toBe(true);
    expect(routeKey({ chatId: 42 })).toBe('42');
  });

  it('treats thread id 1 as General', () => {
    expect(isGeneral({ chatId: 42, threadId: GENERAL_TOPIC_ID })).toBe(true);
    expect(routeKey({ chatId: 42, threadId: 1 })).toBe('42');
  });

  it('keys a real topic as chatId:threadId', () => {
    expect(isGeneral({ chatId: 42, threadId: 7 })).toBe(false);
    expect(routeKey({ chatId: 42, threadId: 7 })).toBe('42:7');
  });
});

describe('sendOptions', () => {
  it('omits message_thread_id for General (byte-identical to non-topic sends)', () => {
    expect(sendOptions({ chatId: 42 })).toEqual({});
    expect(sendOptions({ chatId: 42, threadId: GENERAL_TOPIC_ID })).toEqual({});
  });

  it('pins the reply to a real topic', () => {
    expect(sendOptions({ chatId: 42, threadId: 7 })).toEqual({ message_thread_id: 7 });
  });
});
