import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandoffRecord } from '../agent/daemon/handoff-store.js';
import { writeHandoff, readHandoff, updateHandoffAnswer } from '../agent/daemon/handoff-store.js';
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
  return {
    telegram: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
    },
    action: vi.fn((re: RegExp, handler: (ctx: unknown) => Promise<void>) => {
      actions.push({ re, handler });
    }),
    _actions: actions,
  } as unknown as import('telegraf').Telegraf;
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
    const record = makeRecord();
    await writeHandoff(record, handoffsDir);

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
    // Buttons should use afk:h: prefix
    const buttons = call[2].reply_markup.inline_keyboard;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveLength(2); // Yes + No
    expect(buttons[0][0].callback_data).toMatch(/^afk:h:/);
  });

  it('sends a choice question with per-option buttons', async () => {
    const bot = mockBot();
    const record = makeRecord({
      question: {
        message: 'Pick a color',
        type: 'choice',
        choices: ['Red', 'Green', 'Blue'],
      },
    });
    await writeHandoff(record, handoffsDir);

    const result = await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });
    expect(result.ok).toBe(true);

    const call = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const buttons = call[2].reply_markup.inline_keyboard;
    expect(buttons).toHaveLength(3);
  });

  it('sends a text question as plain message and registers for reply-to', async () => {
    const bot = mockBot();
    const record = makeRecord({
      question: { message: 'What is the password?', type: 'text' },
    });
    await writeHandoff(record, handoffsDir);

    const result = await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });
    expect(result.ok).toBe(true);

    const call = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // No reply_markup for text questions
    expect(call[2]).not.toHaveProperty('reply_markup');
    expect(call[1]).toContain('Reply to this message');
  });

  it('persists route and telegramMessageId to the handoff record', async () => {
    const bot = mockBot();
    const record = makeRecord();
    await writeHandoff(record, handoffsDir);

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
    const record = makeRecord();
    await writeHandoff(record, handoffsDir);

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
    const record = makeRecord();
    await writeHandoff(record, handoffsDir);

    await sendHandoffQuestion({ bot, record, chatId: 55555, threadId: 7, handoffsDir });

    const updated = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(updated.status).toBe('pending');
    expect(updated.route).toEqual({ chatId: 55555, threadId: 7 });
    expect(updated.telegramMessageId).toBe(42);
  });

  it('persistRouteAndMessageId: skips write when record transitions to answered before persist', async () => {
    const bot = mockBot();
    const record = makeRecord();
    await writeHandoff(record, handoffsDir);

    // Intercept sendMessage to simulate the operator answering in the narrow
    // window between sendMessage resolving and persistRouteAndMessageId writing.
    (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Concurrent answer lands while the Telegram send is "in-flight".
      await updateHandoffAnswer(record.taskId, { value: true }, 'telegram', handoffsDir);
      return { message_id: 42 };
    });

    await sendHandoffQuestion({ bot, record, chatId: 99999, handoffsDir });

    // The record on disk must reflect the answer, not the stale pending+route overwrite.
    const onDisk = await readHandoff(record.taskId, handoffsDir);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.status).toBe('answered');
    // route and telegramMessageId must NOT have been written (would require status=pending)
    expect(onDisk!.route).toBeUndefined();
    expect(onDisk!.telegramMessageId).toBeUndefined();
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
    const record = makeRecord({
      question: { message: 'What is the name?', type: 'text' },
    });
    await writeHandoff(record, handoffsDir);

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
  });

  it('validates number replies', async () => {
    const bot = mockBot();
    const record = makeRecord({
      question: { message: 'How many?', type: 'number' },
    });
    await writeHandoff(record, handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    // Invalid number -- consumed but not answered
    const consumed1 = await matchReplyToHandoff(bot, 12345, 42, 'not-a-number', handoffsDir);
    expect(consumed1).toBe(true);
    const still = JSON.parse(
      await readFile(join(handoffsDir, `${record.taskId}.json`), 'utf-8'),
    ) as HandoffRecord;
    expect(still.status).toBe('pending');
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
    const record = makeRecord({
      question: {
        message: 'Pick a deployment target',
        type: 'choice',
        choices: ['prod', 'staging'],
        allowCustom: true,
      },
    });
    await writeHandoff(record, handoffsDir);

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
    const record = makeRecord({
      question: {
        message: 'Pick a deployment target',
        type: 'choice',
        choices: ['prod', 'staging'],
        allowCustom: true,
      },
    });
    await writeHandoff(record, handoffsDir);
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
    const record = makeRecord({
      question: {
        message: 'Pick a color',
        type: 'choice',
        choices: ['Red', 'Green'],
      },
    });
    await writeHandoff(record, handoffsDir);
    await sendHandoffQuestion({ bot, record, chatId: 12345, handoffsDir });

    // Without allowCustom, reply-to should not be registered
    const consumed = await matchReplyToHandoff(bot, 12345, 42, 'Blue');
    expect(consumed).toBe(false);
  });

  it('multi_choice+allowCustom: accepts non-numeric text as custom_value', async () => {
    const bot = mockBot();
    const record = makeRecord({
      question: {
        message: 'Pick features',
        type: 'multi_choice',
        choices: ['auth', 'logging', 'metrics'],
        allowCustom: true,
      },
    });
    await writeHandoff(record, handoffsDir);
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
    const record = makeRecord({
      question: {
        message: 'Pick features',
        type: 'multi_choice',
        choices: ['auth', 'logging', 'metrics'],
      },
    });
    await writeHandoff(record, handoffsDir);
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
    const record = makeRecord({
      question: {
        message: 'Pick features',
        type: 'multi_choice',
        choices: ['auth', 'logging', 'metrics'],
        allowCustom: true,
      },
    });
    await writeHandoff(record, handoffsDir);
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
// registerHandoffAnswerHandlers
// ---------------------------------------------------------------------------

describe('registerHandoffAnswerHandlers', () => {
  it('registers a bot.action handler with the afk:h: prefix', () => {
    const bot = mockBot();
    registerHandoffAnswerHandlers(bot);
    expect((bot.action as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const re = (bot.action as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RegExp;
    expect(re.test('afk:h:0:q-123')).toBe(true);
    expect(re.test('afk:e:0:elic-abc')).toBe(false);
  });
});
