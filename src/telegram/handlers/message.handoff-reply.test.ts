import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, Telegraf } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../../agent/daemon/handoff-store.js';
import { clearPendingTextHandoff, sendHandoffQuestion } from '../handoff-answer.js';
import type { SessionManager } from '../session-manager.js';
import { MessageHandler } from './message.js';

const { streamResponse } = vi.hoisted(() => ({ streamResponse: vi.fn(async () => {}) }));
vi.mock('../streaming.js', () => ({ streamResponse }));
vi.mock('./registration.js', () => ({ registerChatCommands: vi.fn(async () => {}) }));

const TASK = 'q-1716000000000-abc123';
const CHAT = 12345;
const OTHER_CHAT = 67890;
const QUESTION_MESSAGE = 42;
const REPLY_MESSAGE = 100;
const THREAD = 7;
const CLOSED = 'This question is no longer open.';

function makeRecord(question: store.HandoffRecord['question']): store.HandoffRecord {
  return {
    taskId: TASK,
    sessionId: 'test-session',
    question: { message: 'What is your answer?', ...question },
    requestType: 'ask_question',
    createdAt: new Date().toISOString(),
    status: 'pending',
    originalCommand: 'test',
  };
}

function harness() {
  const telegram = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: QUESTION_MESSAGE }),
    editMessageText: vi.fn().mockResolvedValue(true),
  };
  const bot = { telegram } as unknown as Telegraf;
  const getSession = vi.fn().mockResolvedValue({
    state: 'idle',
    waitForInitialization: vi.fn().mockResolvedValue({ sessionId: 'test-session' }),
  });
  const sessions = { getSession, getSessionIfExists: vi.fn() } as unknown as SessionManager;
  const handler = new MessageHandler(bot, sessions, new Set(), vi.fn());
  const runSlash = vi.spyOn(handler, 'runSlash').mockResolvedValue(true);

  async function receive(text: string, opts: { chatId?: number; replyTo?: number; threadId?: number } = {}) {
    const chat = { id: opts.chatId ?? CHAT, type: 'private' };
    const ctx = {
      chat,
      message: {
        chat,
        text,
        message_id: REPLY_MESSAGE,
        message_thread_id: opts.threadId,
        from: { id: 7, username: 'alice' },
        ...(opts.replyTo === undefined ? {} : {
          reply_to_message: { message_id: opts.replyTo, chat, from: { id: 999, is_bot: true } },
        }),
      },
      botInfo: { id: 999 },
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
      sendChatAction: vi.fn(async () => {}),
    } as unknown as Context;
    await handler.handle(ctx);
  }

  return { bot, telegram, receive, getSession, runSlash };
}

async function saveQuestion(question: store.HandoffRecord['question'], threadId?: number) {
  const record = await store.writeHandoff(makeRecord(question));
  await store.updateHandoffMessage(TASK, record.questionId, { chatId: CHAT, threadId }, QUESTION_MESSAGE, undefined, {
    preserveRoute: true,
  });
  return record;
}

function expectConsumed(h: ReturnType<typeof harness>) {
  expect(h.getSession).not.toHaveBeenCalled();
  expect(streamResponse).not.toHaveBeenCalled();
  expect(h.runSlash).not.toHaveBeenCalled();
}

function expectNotice(h: ReturnType<typeof harness>, text: string, threadId?: number) {
  expect(h.telegram.sendMessage).toHaveBeenLastCalledWith(CHAT, text, expect.objectContaining({
    reply_parameters: { message_id: QUESTION_MESSAGE },
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
  }));
}

describe('MessageHandler durable Telegram replies', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'message-handoff-reply-'));
    vi.stubEnv('AFK_STATE_DIR', stateDir);
    streamResponse.mockClear();
  });

  afterEach(async () => {
    clearPendingTextHandoff(TASK);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('answers a saved prompt with slash-leading literal text, scoped to the delivered identity', async () => {
    const h = harness();
    const { questionId } = await saveQuestion({ type: 'text' }, THREAD);
    const update = vi.spyOn(store, 'updateHandoffAnswer');

    await h.receive('/clear', { replyTo: QUESTION_MESSAGE, threadId: THREAD });

    expectConsumed(h);
    expect(update).toHaveBeenCalledWith(TASK, { value: '/clear' }, 'telegram', expect.objectContaining({
      expectedQuestionId: questionId,
      responderIdentity: '7:alice',
    }));
    expect(await store.readHandoff(TASK)).toMatchObject({ status: 'answered', answer: { value: '/clear' } });
    expectNotice(h, 'Answer recorded.', THREAD);
    expect(h.telegram.editMessageText).not.toHaveBeenCalled();
  });

  it('consumes an invalid number and asks for a correction in the original topic', async () => {
    const h = harness();
    await saveQuestion({ type: 'number' }, THREAD);

    await h.receive('not a number', { replyTo: QUESTION_MESSAGE, threadId: THREAD });

    expectConsumed(h);
    expect(await store.readHandoff(TASK)).toMatchObject({ status: 'pending' });
    expectNotice(h, 'Please reply with a valid number.', THREAD);
  });

  it('does not use a cached prompt for an identical message ID in a different chat', async () => {
    const h = harness();
    const record = await store.writeHandoff(makeRecord({ type: 'text' }));
    await sendHandoffQuestion({ bot: h.bot, record, chatId: CHAT });

    await h.receive('not meant for the handoff', { chatId: OTHER_CHAT, replyTo: QUESTION_MESSAGE });

    expect(streamResponse).toHaveBeenCalledOnce();
    expect(await store.readHandoff(TASK)).toMatchObject({ status: 'pending' });
    expect(h.telegram.sendMessage).toHaveBeenCalledOnce();
    expect(h.telegram.editMessageText).not.toHaveBeenCalled();
  });

  it.each([999, undefined])('routes ordinary text normally (reply target %s)', async (replyTo) => {
    const h = harness();
    await saveQuestion({ type: 'text' });

    await h.receive('ordinary message', { replyTo });

    expect(streamResponse).toHaveBeenCalledOnce();
    expect(await store.readHandoff(TASK)).toMatchObject({ status: 'pending' });
    expect(h.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('consumes a reply to a saved stale copy without answering its replacement', async () => {
    const h = harness();
    await saveQuestion({ type: 'text' });
    const replacement = await store.writeHandoff(makeRecord({ type: 'text', message: 'Replacement?' }));

    await h.receive('old answer', { replyTo: QUESTION_MESSAGE });

    expectConsumed(h);
    expect(await store.readHandoff(TASK)).toMatchObject({ status: 'pending', questionId: replacement.questionId });
    expectNotice(h, CLOSED);
  });

  it('does not answer a replacement that wins the race after reply lookup', async () => {
    const h = harness();
    const record = await saveQuestion({ type: 'text' });
    const originalUpdate = store.updateHandoffAnswer;
    vi.spyOn(store, 'updateHandoffAnswer').mockImplementationOnce(async (...args) => {
      await store.writeHandoff(makeRecord({ type: 'text', message: 'Replacement?' }));
      return originalUpdate(...args);
    });

    await h.receive('old answer', { replyTo: QUESTION_MESSAGE });

    expectConsumed(h);
    const current = await store.readHandoff(TASK);
    expect(current).toMatchObject({ status: 'pending', question: { message: 'Replacement?' } });
    expect(current?.questionId).not.toBe(record.questionId);
    expectNotice(h, CLOSED);
  });

  it.each([CHAT, OTHER_CHAT])('answers from destination %s with the same message ID in both chats', async (chatId) => {
    const h = harness();
    const record = await saveQuestion({ type: 'text' });
    await store.updateHandoffMessage(TASK, record.questionId, { chatId: OTHER_CHAT }, QUESTION_MESSAGE, undefined, {
      preserveRoute: true,
    });

    const other = chatId === CHAT ? OTHER_CHAT : CHAT;
    await h.receive('first answer', { chatId, replyTo: QUESTION_MESSAGE });
    await h.receive('second answer', { chatId: other, replyTo: QUESTION_MESSAGE });

    expectConsumed(h);
    expect(await store.readHandoff(TASK)).toMatchObject({ status: 'answered', answer: { value: 'first answer' } });
    expect(h.telegram.sendMessage.mock.calls.map(([id, text]) => [id, text])).toEqual([
      [chatId, 'Answer recorded.'], [other, CLOSED],
    ]);
  });

  it.each([QUESTION_MESSAGE, 43])('accepts the first reply to either copy after resend (message %s)', async (replyTo) => {
    const h = harness();
    const record = await saveQuestion({ type: 'text' });
    await store.updateHandoffMessage(TASK, record.questionId, { chatId: CHAT }, 43, undefined, { preserveRoute: true });

    const other = replyTo === QUESTION_MESSAGE ? 43 : QUESTION_MESSAGE;
    await h.receive('first answer', { replyTo });
    await h.receive('second answer', { replyTo: other });

    expectConsumed(h);
    expect(await store.readHandoff(TASK)).toMatchObject({ status: 'answered', answer: { value: 'first answer' } });
    expect(h.telegram.sendMessage).toHaveBeenNthCalledWith(1, CHAT, 'Answer recorded.', {
      reply_parameters: { message_id: replyTo },
    });
    expect(h.telegram.sendMessage).toHaveBeenLastCalledWith(CHAT, CLOSED, {
      reply_parameters: { message_id: other },
    });
  });

  it('leaves a button-only prompt reply to normal routing', async () => {
    const h = harness();
    await saveQuestion({ type: 'confirm' });

    await h.receive('a normal reply', { replyTo: QUESTION_MESSAGE });

    expect(streamResponse).toHaveBeenCalledOnce();
    expect(await store.readHandoff(TASK)).toMatchObject({ status: 'pending' });
    expect(h.telegram.sendMessage).not.toHaveBeenCalled();
  });
});
