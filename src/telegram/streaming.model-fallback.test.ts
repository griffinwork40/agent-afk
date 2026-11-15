import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'telegraf';
import type { IAgentSession, OutputEvent } from '../agent/types.js';
import { streamResponse } from './streaming.js';

const CHAT_ID = -10012345;
const NOTICE_ID = 900;
const noticeText = 'Switched opus → gpt-5.5 (usage-limit). <plain> _text_';

function makeCtx(source: 'chat' | 'message' | 'callback') {
  let nextId = 1;
  const ctx = {
    chat: { id: CHAT_ID, type: 'supergroup' },
    ...(source === 'message' ? { message: { message_thread_id: 42, is_topic_message: true } } : {}),
    ...(source === 'callback' ? { callbackQuery: { message: { message_thread_id: 73, is_topic_message: true } } } : {}),
    reply: vi.fn(async (text: string) => ({ message_id: nextId++, text, chat: { id: CHAT_ID }, date: 0 })),
    telegram: {
      sendMessage: vi.fn(async (_chatId: number, text: string) => ({ message_id: NOTICE_ID, text, chat: { id: CHAT_ID }, date: 0 })),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  };
  return { ctx: ctx as unknown as Context, reply: ctx.reply, ...ctx.telegram };
}

function makeSession(notice: OutputEvent): IAgentSession {
  return {
    sendMessageStream: async function* () {
      yield notice;
      // An authoritative assistant message replaces the preview accumulator.
      yield { type: 'message', message: { role: 'assistant', content: 'Final answer' } } as OutputEvent;
      yield { type: 'done', metadata: undefined } as OutputEvent;
    },
  } as unknown as IAgentSession;
}

describe('Telegram model-fallback notices', () => {
  for (const cleanFinal of [false, true]) {
    it.each([
      ['chat', {}],
      ['message', { message_thread_id: 42 }],
      ['callback', { message_thread_id: 73 }],
    ] as const)('sends a separate plain message for %s routes (cleanFinal=' + cleanFinal + ')', async (source, options) => {
      const { ctx, reply, sendMessage, editMessageText, deleteMessage } = makeCtx(source);
      const onComplete = vi.fn();
      const session = makeSession({
        type: 'notice', kind: 'model-fallback', text: noticeText,
        fallback: { from: 'opus', to: 'gpt-5.5', reason: 'usage-limit' },
      });

      await streamResponse(ctx, session, 'go', undefined, { cleanFinal, onComplete });

      expect(sendMessage).toHaveBeenCalledExactlyOnceWith(CHAT_ID, noticeText, options);
      // No parse_mode, markdown conversion, or notice text in model output.
      for (const [text] of reply.mock.calls) expect(text).not.toContain(noticeText);
      for (const call of editMessageText.mock.calls) {
        expect(call[1]).not.toBe(NOTICE_ID);
        expect(call[3]).not.toContain(noticeText);
      }
      for (const call of deleteMessage.mock.calls) expect(call[1]).not.toBe(NOTICE_ID);
      expect(onComplete).toHaveBeenCalledWith('Final answer', undefined);
      if (cleanFinal) {
        expect(reply).toHaveBeenCalledWith('Final answer', { parse_mode: 'HTML' });
        expect(deleteMessage).toHaveBeenCalledWith(CHAT_ID, 1);
      } else {
        expect(editMessageText).toHaveBeenCalledWith(CHAT_ID, 1, undefined, 'Final answer', { parse_mode: 'HTML' });
        expect(deleteMessage).not.toHaveBeenCalled();
      }
    });
  }

  it('keeps streaming when sendMessage rejects for the fallback notice', async () => {
    const { ctx, sendMessage, onComplete } = (() => {
      const m = makeCtx('chat');
      return { ...m, onComplete: vi.fn() };
    })();
    sendMessage.mockRejectedValueOnce(new Error('429 Too Many Requests'));
    const session = makeSession({
      type: 'notice', kind: 'model-fallback', text: noticeText,
      fallback: { from: 'opus', to: 'gpt-5.5', reason: 'usage-limit' },
    });

    await streamResponse(ctx, session, 'go', undefined, { onComplete });

    expect(onComplete).toHaveBeenCalledWith('Final answer', undefined);
  });

  it('keeps generic notices in the existing italic inline preview path', async () => {
    const { ctx, sendMessage, editMessageText } = makeCtx('message');
    const session = makeSession({ type: 'notice', kind: 'truncation', text: 'Output truncated' });

    await streamResponse(ctx, session, 'go');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText.mock.calls.some(call => String(call[3]).includes('<i>ℹ Output truncated</i>'))).toBe(true);
  });
});
