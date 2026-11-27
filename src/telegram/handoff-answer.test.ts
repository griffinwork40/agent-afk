import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHandoffsDir } from '../paths.js';
import type { HandoffRecord } from '../agent/daemon/handoff-store.js';
import { writeHandoff, readHandoff, updateHandoffAnswer } from '../agent/daemon/handoff-store.js';
import { buildHandoffCallback } from './handoff-callback-data.js';
import {
  sendHandoffQuestion,
  matchReplyToHandoff,
  registerHandoffAnswerHandlers,
  clearPendingTextHandoff,
} from './handoff-answer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return mkdtemp(join(tmpdir(), 'handoff-answer-test-'));
}

function makeRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    taskId: 'q-1716000000000-abc123',
    sessionId: 'test-session',
    question: { message: 'Approve the deployment?', type: 'confirm' },
    requestType: 'ask_question',
    createdAt: new Date().toISOString(),
    status: 'pending',
    originalCommand: 'deploy prod',
    ...overrides,
  };
}

/** Minimal mock of a Telegraf bot for testing. */
function mockBot() {
  const actions: Array<{ re: RegExp; handler: (ctx: unknown) => Promise<void> }> = [];
  const bot = {
    telegram: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
    },
    action: vi.fn((re: RegExp, handler: (ctx: unknown) => Promise<void>) => {
      actions.push({ re, handler });
    }),
    actions,
  };
  return bot as typeof bot & import('telegraf').Telegraf;
}

// ---------------------------------------------------------------------------
// sendHandoffQuestion
// ---------------------------------------------------------------------------

describe('sendHandoffQuestion', () => {
  let handoffsDir: string;

  beforeEach(async () => {
    handoffsDir = await makeTmpDir();
  });

  it('sends a confirm question with inline buttons and returns messageId', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord(), handoffsDir);

    const result = await sendHandoffQuestion({
      bot,
      record,
      chatId: 12345,
      handoffsDir,
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(42);

    // Verify sendMessage was called with HTML and inline keyboard
    const call = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe(12345);
    expect(call[1]).toContain('Approve the deployment?');
    expect(call[2]).toHaveProperty('parse_mode', 'HTML');
    expect(call[2]).toHaveProperty('reply_markup');
    expect(call[2].reply_markup).toEqual({ inline_keyboard: [[
      { text: 'Yes', callback_data: `afk:h:q:1:${record.questionId}` },
      { text: 'No', callback_data: `afk:h:q:0:${record.questionId}` },
    ]] });
  });

  it('sends usable inline buttons for a 60-character task ID', async () => {
    const bot = mockBot();
    const taskId = 'a'.repeat(60);
    // Read back rather than depending on the new return type, so this test also runs against main.
    await writeHandoff(makeRecord({ taskId }), handoffsDir);
    const record = (await readHandoff(taskId, handoffsDir))!;

    const result = await sendHandoffQuestion({
      bot, record, chatId: 12345, handoffsDir,
    });
    expect(result.ok).toBe(true);
    const markup = bot.telegram.sendMessage.mock.calls[0]![2]?.reply_markup;
    expect(markup).toEqual({ inline_keyboard: [[
      { text: 'Yes', callback_data: `afk:h:q:1:${record.questionId}` },
      { text: 'No', callback_data: `afk:h:q:0:${record.questionId}` },
    ]] });
  });

  it('still sends a plain message when a legacy task ID is too long for buttons', async () => {
    const bot = mockBot();
    const record = makeRecord({ taskId: 'a'.repeat(60) });
    await writeFile(join(handoffsDir, `${record.taskId}.json`), JSON.stringify(record));

    expect(await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir })).toEqual({ ok: true, messageId: 42 });
    const [, text, options] = bot.telegram.sendMessage.mock.calls[0]!;
    expect(text).toContain('Approve the deployment?');
    expect(options).not.toHaveProperty('reply_markup');
    expect(await readHandoff(record.taskId, handoffsDir)).toMatchObject({ telegramMessageId: 42 });
  });

  it('sends a choice question with per-option buttons', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: {
        message: 'Pick a color',
        type: 'choice',
        choices: ['Red', 'Green', 'Blue'],
      },
    }), handoffsDir);

    const result = await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });
    expect(result.ok).toBe(true);

    const call = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const buttons = call[2].reply_markup.inline_keyboard;
    expect(buttons).toHaveLength(3);
  });

  it('sends a text question with ForceReply and registers for reply-to', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: { message: 'What is the password?', type: 'text' },
    }), handoffsDir);

    const result = await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });
    expect(result.ok).toBe(true);

    const call = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[2].reply_markup).toEqual({ force_reply: true });
    expect(call[1]).toContain('Reply to this message');
  });

  it('persists route and telegramMessageId to the handoff record', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord(), handoffsDir);

    await sendHandoffQuestion({ bot, record, chatId: 12345, threadId: 99, handoffsDir });

    // Read the updated record from disk
    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.route).toEqual({ chatId: 12345, threadId: 99 });
    expect(updated.telegramMessageId).toBe(42);
  });

  it('includes thread_id in send options for supergroups', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord(), handoffsDir);

    await sendHandoffQuestion({ bot, record, chatId: 12345, threadId: 77, handoffsDir });

    const call = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[2]).toHaveProperty('message_thread_id', 77);
  });

  it('returns ok:false on sendMessage failure', async () => {
    const bot = mockBot();
    (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));
    const record = makeRecord();

    const result = await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });
    expect(result.ok).toBe(false);
    expect(result.messageId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // persistRouteAndMessageId race-condition tests (#1549)
  // -------------------------------------------------------------------------

  it('persistRouteAndMessageId: updates route/messageId on a still-pending record', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord(), handoffsDir);

    await sendHandoffQuestion({ bot, record, chatId: 55555, threadId: 7, handoffsDir });

    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.status).toBe('pending');
    expect(updated.route).toEqual({ chatId: 55555, threadId: 7 });
    expect(updated.telegramMessageId).toBe(42);
  });

  it('tracks a late delivery without clobbering a concurrent answer', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord(), handoffsDir);

    // Intercept sendMessage to simulate the operator answering in the narrow
    // window between sendMessage resolving and persistRouteAndMessageId writing.
    (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Concurrent answer lands while the Telegram send is "in-flight".
      await updateHandoffAnswer(record.taskId, { value: true }, 'telegram', { handoffsDir });
      return { message_id: 42 };
    });

    await sendHandoffQuestion({ bot, record, chatId: 99999, handoffsDir });

    expect(await readHandoff(record.taskId, handoffsDir)).toMatchObject({
      status: 'answered',
      answer: { value: true },
      telegramCopies: [{ chatId: 99999, messageId: 42, questionId: record.questionId }],
    });
  });

  it('does not attach metadata from an in-flight send to a replacement question', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord(), handoffsDir);
    const question = { message: 'Replacement?', type: 'confirm' };
    bot.telegram.sendMessage.mockImplementationOnce(async () => {
      await writeHandoff(makeRecord({ taskId: record.taskId, question }), handoffsDir);
      return { message_id: 42 };
    });

    expect(await sendHandoffQuestion({ bot, record, chatId: 12345, threadId: 99, handoffsDir })).toMatchObject({ ok: true });
    const replacement = await readHandoff(record.taskId, handoffsDir);
    expect(replacement).toMatchObject({ status: 'pending', question });
    expect(replacement?.questionId).not.toBe(record.questionId);
    expect(replacement?.route).toBeUndefined();
    expect(replacement?.telegramMessageId).toBeUndefined();
  });

  afterEach(async () => {
    if (handoffsDir) await rm(handoffsDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// matchReplyToHandoff
// ---------------------------------------------------------------------------

describe('matchReplyToHandoff', () => {
  let handoffsDir: string;

  beforeEach(async () => {
    handoffsDir = await makeTmpDir();
    // Clear any leftover pending entries from prior tests
    clearPendingTextHandoff('q-1716000000000-abc123');
  });

  it('returns false when no pending handoff matches the message_id', async () => {
    const bot = mockBot();
    const consumed = await matchReplyToHandoff(bot, 12345, 999, 'some answer');
    expect(consumed).toBe(false);
  });

  it('consumes a text reply and records the answer', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: { message: 'What is the name?', type: 'text' },
    }), handoffsDir);

    // Send the question to register the reply-to mapping
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });
    const messageId = 42; // mock returns 42

    // Simulate the operator replying
    const consumed = await matchReplyToHandoff(bot, 12345, messageId, 'Alice', handoffsDir);
    expect(consumed).toBe(true);

    // The record should now be answered on disk
    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.status).toBe('answered');
    expect(updated.answer).toEqual({ value: 'Alice' });
    expect(updated.answerSource).toBe('telegram');
    expect(bot.telegram.editMessageText).toHaveBeenCalledWith(12345, 42, undefined, 'Answered: Alice');
  });

  it('validates number replies', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: { message: 'How many?', type: 'number' },
    }), handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    // Invalid number -- consumed but not answered
    const consumed1 = await matchReplyToHandoff(bot, 12345, 42, 'not-a-number', handoffsDir);
    expect(consumed1).toBe(true);
    const still = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(still.status).toBe('pending');
  });

  it('records responderIdentity with userId and username when fromUser is provided', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: { message: 'Confirm?', type: 'text' },
    }), handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    const consumed = await matchReplyToHandoff(
      bot, 12345, 42, 'sure',
      handoffsDir,
      { id: 111222333, username: 'bob' },
    );
    expect(consumed).toBe(true);

    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.responderIdentity).toBe('111222333:bob');
    expect(updated.answerSource).toBe('telegram');
  });

  it('records responderIdentity with userId only when username is absent', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: { message: 'Proceed?', type: 'text' },
    }), handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    const consumed = await matchReplyToHandoff(
      bot, 12345, 42, 'yes',
      handoffsDir,
      { id: 999888777 },
    );
    expect(consumed).toBe(true);

    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.responderIdentity).toBe('999888777');
  });

  it('leaves responderIdentity undefined when fromUser is not provided', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: { message: 'Skip me?', type: 'text' },
    }), handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    await matchReplyToHandoff(bot, 12345, 42, 'nope', handoffsDir);

    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.responderIdentity).toBeUndefined();
  });

  afterEach(async () => {
    if (handoffsDir) await rm(handoffsDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// allowCustom behavior
// ---------------------------------------------------------------------------

describe('allowCustom', () => {
  let handoffsDir: string;

  beforeEach(async () => {
    handoffsDir = await makeTmpDir();
    clearPendingTextHandoff('q-1716000000000-abc123');
  });

  afterEach(async () => {
    if (handoffsDir) await rm(handoffsDir, { recursive: true, force: true }).catch(() => {});
  });

  it('choice+allowCustom: pendingTextHandoffs is populated after sendHandoffQuestion', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: {
        message: 'Pick a deployment target',
        type: 'choice',
        choices: ['prod', 'staging'],
        allowCustom: true,
      },
    }), handoffsDir);

    const result = await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });
    expect(result.ok).toBe(true);

    // Should have included the custom hint in the message
    const call = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toContain('custom answer');

    // Should still have inline keyboard buttons
    expect(call[2]).toHaveProperty('reply_markup');

    // The message_id should be registered for reply-to matching
    // Verify by replying -- if not registered, matchReplyToHandoff returns false
    const consumed = await matchReplyToHandoff(bot, 12345, 42, 'my-custom-env', handoffsDir);
    expect(consumed).toBe(true);
  });

  it('choice+allowCustom: matchReplyToHandoff accepts free text as custom_value', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: {
        message: 'Pick a deployment target',
        type: 'choice',
        choices: ['prod', 'staging'],
        allowCustom: true,
      },
    }), handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    const consumed = await matchReplyToHandoff(bot, 12345, 42, 'canary', handoffsDir);
    expect(consumed).toBe(true);

    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.status).toBe('answered');
    expect(updated.answer).toEqual({ value: null, custom_value: 'canary' });
  });

  it('choice without allowCustom: no reply-to path registered', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: {
        message: 'Pick a color',
        type: 'choice',
        choices: ['Red', 'Green'],
      },
    }), handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    // Without allowCustom, reply-to should not be registered
    const consumed = await matchReplyToHandoff(bot, 12345, 42, 'Blue');
    expect(consumed).toBe(false);
  });

  it('multi_choice+allowCustom: accepts non-numeric text as custom_value', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: {
        message: 'Pick features',
        type: 'multi_choice',
        choices: ['auth', 'logging', 'metrics'],
        allowCustom: true,
      },
    }), handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    const consumed = await matchReplyToHandoff(bot, 12345, 42, 'tracing', handoffsDir);
    expect(consumed).toBe(true);

    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.status).toBe('answered');
    expect(updated.answer).toEqual({ value: null, custom_value: 'tracing' });
  });

  it('multi_choice without allowCustom: rejects non-numeric text', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: {
        message: 'Pick features',
        type: 'multi_choice',
        choices: ['auth', 'logging', 'metrics'],
      },
    }), handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    // Non-numeric text should be rejected (consumed=true, but still pending)
    const consumed = await matchReplyToHandoff(bot, 12345, 42, 'tracing', handoffsDir);
    expect(consumed).toBe(true);

    // Should have sent an error message
    const sendCalls = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    // First call is sendHandoffQuestion, second is the error reply
    expect(sendCalls.length).toBeGreaterThan(1);
    const errorCall = sendCalls[sendCalls.length - 1]!;
    expect(errorCall[1]).toContain('comma-separated numbers');
  });

  it('multi_choice+allowCustom: still accepts valid numeric lists', async () => {
    const bot = mockBot();
    const record = await writeHandoff(makeRecord({
      question: {
        message: 'Pick features',
        type: 'multi_choice',
        choices: ['auth', 'logging', 'metrics'],
        allowCustom: true,
      },
    }), handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    const consumed = await matchReplyToHandoff(bot, 12345, 42, '1,3', handoffsDir);
    expect(consumed).toBe(true);

    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.status).toBe('answered');
    expect(updated.answer).toEqual({ value: ['auth', 'metrics'] });
  });
});

// ---------------------------------------------------------------------------
// registerHandoffAnswerHandlers — mocked Telegram with the durable store
// ---------------------------------------------------------------------------

describe('registerHandoffAnswerHandlers', () => {
  const keyboardRemoved = { reply_markup: { inline_keyboard: [] } };
  let stateDir: string;
  let handoffsDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir();
    // The registered callback uses the default store without a path override.
    vi.stubEnv('AFK_STATE_DIR', stateDir);
    handoffsDir = getHandoffsDir();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true });
  });

  async function tap(data: string, from: { id: number; username?: string } = { id: 9 }) {
    const bot = mockBot();
    registerHandoffAnswerHandlers(bot);
    expect(bot.actions).toHaveLength(1);
    const { re, handler } = bot.actions[0]!;
    expect(re.test(data)).toBe(true);
    expect(re.test('afk:e:0:elic-abc')).toBe(false);
    const ctx = {
      callbackQuery: { data, from },
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    };
    await handler(ctx);
    expect(ctx.answerCbQuery).toHaveBeenCalledOnce();
    return ctx;
  }

  function expectClosed(ctx: Awaited<ReturnType<typeof tap>>) {
    expect(ctx.answerCbQuery).toHaveBeenCalledWith('This question is no longer open.');
    expect(ctx.editMessageText).toHaveBeenCalledWith('This question is no longer open.', keyboardRemoved);
  }

  it('keeps the replacement pending when a superseded button is tapped', async () => {
    const bot = mockBot();
    const original = makeRecord();
    await writeHandoff(original, handoffsDir);
    const record = (await readHandoff(original.taskId, handoffsDir))!;
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });
    const markup = bot.telegram.sendMessage.mock.calls[0]![2]?.reply_markup;
    const data: string = markup.inline_keyboard[0][0].callback_data;

    const question = { message: 'Delete the preview?', type: 'confirm' };
    await writeHandoff(makeRecord({ taskId: original.taskId, question }), handoffsDir);
    const ctx = await tap(data);

    expect(await readHandoff(original.taskId, handoffsDir)).toMatchObject({ status: 'pending', question });
    expectClosed(ctx);
  });

  it.each([
    { from: { id: 55667788, username: 'charlie' }, identity: '55667788:charlie' },
    { from: { id: 11223344 }, identity: '11223344' },
  ])('answers the current confirm question directly from disk as $identity', async ({ from, identity }) => {
    const record = await writeHandoff(makeRecord(), handoffsDir);
    const ctx = await tap(buildHandoffCallback(record, 1), from);

    expect(await readHandoff(record.taskId, handoffsDir)).toMatchObject({
      status: 'answered', answer: { value: true }, answerSource: 'telegram', responderIdentity: identity,
    });
    expect(ctx.editMessageText).toHaveBeenCalledWith('Answered: Yes', keyboardRemoved);
  });

  it('answers a current choice button with the selected option', async () => {
    const record = await writeHandoff(makeRecord({
      question: { message: 'Pick a color', type: 'choice', choices: ['Red', 'Blue'] },
    }), handoffsDir);
    const ctx = await tap(buildHandoffCallback(record, 1));

    expect(await readHandoff(record.taskId, handoffsDir)).toMatchObject({
      status: 'answered', answer: { value: 'Blue' },
    });
    expect(ctx.editMessageText).toHaveBeenCalledWith('Answered: Blue', keyboardRemoved);
  });

  it('accepts a legacy button for a record without identity', async () => {
    const record = makeRecord();
    await mkdir(handoffsDir, { recursive: true });
    await writeFile(join(handoffsDir, `${record.taskId}.json`), JSON.stringify(record));
    const ctx = await tap(`afk:h:0:${record.taskId}`);

    expect(await readHandoff(record.taskId, handoffsDir)).toMatchObject({
      status: 'answered', answer: { value: false },
    });
    expect(ctx.editMessageText).toHaveBeenCalledWith('Answered: No', keyboardRemoved);
  });

  it('rejects a legacy button for a record with identity', async () => {
    const record = await writeHandoff(makeRecord(), handoffsDir);
    expectClosed(await tap(`afk:h:1:${record.taskId}`));
    expect(await readHandoff(record.taskId, handoffsDir)).toEqual(record);
  });

  it.each(['answered', 'expired'] as const)('clears a stale button for an %s question', async (status) => {
    const record = await writeHandoff(makeRecord({ status }), handoffsDir);
    expectClosed(await tap(buildHandoffCallback(record, 1)));
    expect(await readHandoff(record.taskId, handoffsDir)).toEqual(record);
  });

  it('leaves the keyboard available to retry when the pending question is locked', async () => {
    const record = await writeHandoff(makeRecord(), handoffsDir);
    await writeFile(join(handoffsDir, `${record.taskId}.lock`), '', { flag: 'wx' });
    const ctx = await tap(buildHandoffCallback(record, 1));

    expect(ctx.answerCbQuery).toHaveBeenCalledWith('Could not record the answer. Please try again.');
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(await readHandoff(record.taskId, handoffsDir)).toEqual(record);
  });

  it('rejects a replacement that arrives between token lookup and the answer write', async () => {
    const record = await writeHandoff(makeRecord(), handoffsDir);
    const store = await import('../agent/daemon/handoff-store.js');
    const update = store.updateHandoffAnswer;
    const question = { message: 'Replacement?', type: 'confirm' };
    vi.spyOn(store, 'updateHandoffAnswer').mockImplementationOnce(async (...args) => {
      await writeHandoff(makeRecord({ taskId: record.taskId, question }), handoffsDir);
      return update(...args);
    });

    expectClosed(await tap(buildHandoffCallback(record, 1)));
    const replacement = await readHandoff(record.taskId, handoffsDir);
    expect(replacement).toMatchObject({ status: 'pending', question });
    expect(replacement?.questionId).not.toBe(record.questionId);
    expect(replacement?.answer).toBeUndefined();
  });
});
