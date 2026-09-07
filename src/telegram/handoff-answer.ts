/**
 * Telegram-side handler for answering durable daemon handoff questions.
 *
 * This module bridges the durable handoff store (daemon-side) to the Telegram
 * bot (operator-side). It:
 *
 *   1. Sends handoff questions as Telegram messages with inline keyboards for
 *      confirm/choice types, or plain messages for text/number types.
 *   2. Registers `bot.action` handlers for inline button taps.
 *   3. Intercepts reply-to-message text for text/number answers.
 *   4. Edits the original message after answering to show visual closure.
 *   5. Calls `answerHandoff()` to record the answer in the durable store.
 *
 * Design contract:
 *   - The handoff question is rendered as a rich Telegram message with the
 *     task ID visible so the operator knows which daemon task is asking.
 *   - For confirm/choice: inline keyboard buttons with `afk:h:` prefix
 *     callback data (disjoint from `afk:e:` in-process elicitation buttons).
 *   - For text/number/multi_choice: the operator replies to the question
 *     message. The bot matches `reply_to_message.message_id` against a
 *     stored mapping to route the answer to the correct handoff.
 *   - After answering, the original message is edited to append a
 *     "Answered" footer and remove the inline keyboard.
 *   - On bot restart, `recoverPendingHandoffs` re-sends questions using
 *     this module's `sendHandoffQuestion` instead of the plain push path.
 *
 * @module telegram/handoff-answer
 */

import { Markup, type Telegraf } from 'telegraf';
import { answerHandoff } from '../agent/daemon/handoff-wiring.js';
import type { HandoffRecord, HandoffRoute } from '../agent/daemon/handoff-store.js';
import { writeHandoff, readHandoff } from '../agent/daemon/handoff-store.js';
import {
  buildHandoffCallback,
  parseHandoffCallback,
  HANDOFF_CALLBACK_PREFIX,
} from './handoff-callback-data.js';
import { escapeHtml } from './formatter.js';
import { escapeRegExp } from '../utils/regexp.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for sendHandoffQuestion. */
export interface SendHandoffOpts {
  /** The bot instance to send through. */
  bot: Telegraf;
  /** The HandoffRecord to present to the operator. */
  record: HandoffRecord;
  /** Target chat ID (from configured notify targets). */
  chatId: number;
  /** Optional topic thread ID for supergroups. */
  threadId?: number;
  /** Handoffs directory override (testing). */
  handoffsDir?: string;
}

/** Result of sending a handoff question. */
export interface SendHandoffResult {
  /** Whether the message was sent successfully. */
  ok: boolean;
  /** Telegram message_id of the sent message (for reply-to matching). */
  messageId?: number;
}

/**
 * In-memory map of Telegram message_id to taskId.
 * Used to match reply-to-message text answers to the correct handoff.
 * Populated when a text/number question is sent, cleared on answer or restart.
 *
 * Invariant: this map is ephemeral — it is rebuilt from the durable store
 * on bot restart via recoverPendingHandoffs → sendHandoffQuestion.
 */
const pendingTextHandoffs = new Map<number, string>();

// ---------------------------------------------------------------------------
// Send a handoff question to Telegram
// ---------------------------------------------------------------------------

/** Max question text chars echoed to Telegram (avoid wall of text). */
const MAX_QUESTION_CHARS = 600;

function truncateQuestion(text: string): string {
  return text.length <= MAX_QUESTION_CHARS
    ? text
    : `${text.slice(0, MAX_QUESTION_CHARS)}...(truncated)`;
}

/** Truncate a button label for display (Telegram allows ~200 bytes for labels; 64-byte cap here is conservative). */
function truncateLabel(label: string, maxBytes = 64): string {
  if (Buffer.byteLength(label, 'utf8') <= maxBytes) return label;
  const buf = Buffer.from(label, 'utf8').subarray(0, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/\uFFFD$/, '');
}

/**
 * Send a handoff question as a rich Telegram message.
 *
 * - confirm: Yes/No inline buttons
 * - choice: one button per option
 * - text/number/multi_choice: plain message (operator replies to answer)
 *
 * Updates the HandoffRecord on disk with `route` and `telegramMessageId`
 * so restart recovery can re-target the correct chat and match replies.
 */
export async function sendHandoffQuestion(opts: SendHandoffOpts): Promise<SendHandoffResult> {
  const { bot, record, chatId, threadId, handoffsDir } = opts;
  const threadOpts = threadId ? { message_thread_id: threadId } : {};

  const question = record.question;
  const qType = (question['type'] as string | undefined) ?? 'text';
  const message = typeof question['message'] === 'string'
    ? question['message']
    : '(question details unavailable)';
  const context = typeof question['context'] === 'string' ? question['context'] : undefined;
  const choices = Array.isArray(question['choices']) ? question['choices'] as string[] : [];

  // Build display header
  let displayText = `🔔 <b>Daemon task needs your answer</b>\n`;
  displayText += `📋 <code>${escapeHtml(record.taskId)}</code>\n\n`;
  if (context) {
    displayText += `<i>${escapeHtml(truncateQuestion(context))}</i>\n\n`;
  }
  displayText += escapeHtml(truncateQuestion(message));

  try {
    if (qType === 'confirm') {
      const buttons = [[
        Markup.button.callback('Yes', buildHandoffCallback(record.taskId, 1)),
        Markup.button.callback('No', buildHandoffCallback(record.taskId, 0)),
      ]];
      const sent = await bot.telegram.sendMessage(chatId, displayText, {
        parse_mode: 'HTML',
        ...threadOpts,
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      });
      await persistRouteAndMessageId(record, chatId, threadId, sent.message_id, handoffsDir);
      return { ok: true, messageId: sent.message_id };
    }

    if (qType === 'choice') {
      const allowCustom = Boolean(question['allowCustom']);
      const MAX_CHOICES = 20;
      const visibleChoices = choices.slice(0, MAX_CHOICES);
      const buttons = visibleChoices.map((choice, i) => [
        Markup.button.callback(
          truncateLabel(String(choice)),
          buildHandoffCallback(record.taskId, i),
        ),
      ]);
      let choiceText = displayText;
      if (allowCustom) {
        choiceText += '\n\n<i>Or reply to this message with a custom answer</i>';
      }
      const sent = await bot.telegram.sendMessage(chatId, choiceText, {
        parse_mode: 'HTML',
        ...threadOpts,
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      });
      if (allowCustom) {
        pendingTextHandoffs.set(sent.message_id, record.taskId);
      }
      await persistRouteAndMessageId(record, chatId, threadId, sent.message_id, handoffsDir);
      return { ok: true, messageId: sent.message_id };
    }

    // text / number / multi_choice: plain message with reply hint
    const allowCustomMulti = qType === 'multi_choice' && Boolean(question['allowCustom']);
    if (qType === 'multi_choice' && choices.length > 0) {
      const choiceList = choices.map((c, i) => `${i + 1}. ${escapeHtml(String(c))}`).join('\n');
      const hint = allowCustomMulti
        ? '<i>Reply with comma-separated numbers (e.g. 1,3) or a custom answer</i>'
        : '<i>Reply with comma-separated numbers (e.g. 1,3)</i>';
      displayText += `\n\n${choiceList}\n\n${hint}`;
    } else if (qType === 'number') {
      const min = question['min'] as number | undefined;
      const max = question['max'] as number | undefined;
      const boundsHint = min !== undefined && max !== undefined
        ? ` (${min}--${max})`
        : min !== undefined ? ` (>=${min})` : max !== undefined ? ` (<=${max})` : '';
      displayText += `\n\n<i>Reply with a number${boundsHint}</i>`;
    } else {
      displayText += '\n\n<i>Reply to this message with your answer</i>';
    }

    const sent = await bot.telegram.sendMessage(chatId, displayText, {
      parse_mode: 'HTML',
      ...threadOpts,
    });
    // Register for reply-to-message matching
    pendingTextHandoffs.set(sent.message_id, record.taskId);
    await persistRouteAndMessageId(record, chatId, threadId, sent.message_id, handoffsDir);
    return { ok: true, messageId: sent.message_id };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[handoff-answer] failed to send question for task ${record.taskId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Register bot handlers
// ---------------------------------------------------------------------------

/**
 * Register the Telegram-side handoff answer handlers on the bot.
 *
 * Call once during bot startup, BEFORE `bot.launch()`, so the action handlers
 * are in place before the first update arrives.
 *
 * Registers:
 *   1. A wildcard `bot.action` for `afk:h:*` callback buttons (confirm/choice).
 *   2. The reply-to-message check is handled by `matchReplyToHandoff`, which
 *      callers wire into their message handler.
 */
export function registerHandoffAnswerHandlers(bot: Telegraf): void {
  const wildcardRe = new RegExp(`^${escapeRegExp(HANDOFF_CALLBACK_PREFIX)}\\d+:.+$`);

  bot.action(wildcardRe, async (ctx) => {
    // Clear Telegram's spinner immediately.
    await ctx.answerCbQuery().catch(() => {});

    const callbackData =
      typeof ctx.callbackQuery === 'object' && 'data' in ctx.callbackQuery
        ? (ctx.callbackQuery as { data: string }).data
        : undefined;
    const parsed = parseHandoffCallback(callbackData);
    if (!parsed) return;

    const { taskId, choiceIndex } = parsed;

    // Resolve the answer from the stored question type.
    // We need the original record to know if it's confirm vs choice.
    const record = await readHandoff(taskId);
    if (!record || record.status !== 'pending') {
      // Already answered or expired -- tell the operator.
      await ctx.editMessageText('This question has already been answered or expired.').catch(() => {});
      return;
    }

    const qType = (record.question['type'] as string | undefined) ?? 'text';
    let answer: unknown;

    if (qType === 'confirm') {
      answer = { value: choiceIndex === 1 };
    } else if (qType === 'choice') {
      const choices = Array.isArray(record.question['choices'])
        ? record.question['choices'] as string[]
        : [];
      const selected = choices[choiceIndex];
      if (selected === undefined) return;
      answer = { value: selected };
    } else {
      // Unexpected qType for a button tap -- ignore.
      return;
    }

    const won = await answerHandoff(taskId, answer, 'telegram').catch(() => false);
    if (won) {
      // Edit the original message to show visual closure.
      const answerLabel = qType === 'confirm'
        ? (choiceIndex === 1 ? 'Yes' : 'No')
        : String((answer as { value: unknown }).value);
      await editMessageAnswered(ctx, answerLabel);
    } else {
      await ctx.editMessageText('This question was already answered from another surface.').catch(() => {});
    }
  });
}

/**
 * Check if an incoming text message is a reply to a pending handoff question.
 *
 * Call from the message handler's text processing path. Returns true if the
 * message was consumed as a handoff answer (caller should skip normal routing).
 *
 * @param bot - The Telegraf bot instance (for editing the original message).
 * @param chatId - The chat the message arrived in.
 * @param replyToMessageId - The message_id of the message being replied to.
 * @param text - The operator's reply text.
 * @param handoffsDir - Override for the handoffs directory (testing).
 * @returns true if the reply was matched and consumed as a handoff answer.
 */
export async function matchReplyToHandoff(
  bot: Telegraf,
  chatId: number,
  replyToMessageId: number,
  text: string,
  handoffsDir?: string,
): Promise<boolean> {
  const taskId = pendingTextHandoffs.get(replyToMessageId);
  if (!taskId) return false;

  const record = await readHandoff(taskId, handoffsDir);
  if (!record || record.status !== 'pending') {
    pendingTextHandoffs.delete(replyToMessageId);
    return false;
  }

  const trimmed = text.trim();
  if (trimmed === '') return false;

  const qType = (record.question['type'] as string | undefined) ?? 'text';
  let answer: unknown;

  if (qType === 'number') {
    const n = Number(trimmed);
    if (!isFinite(n)) {
      await bot.telegram.sendMessage(
        chatId,
        'Please reply with a valid number.',
        { reply_parameters: { message_id: replyToMessageId } },
      ).catch(() => {});
      return true; // consumed, but ask again
    }
    const min = record.question['min'] as number | undefined;
    const max = record.question['max'] as number | undefined;
    if (min !== undefined && n < min) {
      await bot.telegram.sendMessage(
        chatId,
        `Please reply with a number >= ${min}.`,
        { reply_parameters: { message_id: replyToMessageId } },
      ).catch(() => {});
      return true;
    }
    if (max !== undefined && n > max) {
      await bot.telegram.sendMessage(
        chatId,
        `Please reply with a number <= ${max}.`,
        { reply_parameters: { message_id: replyToMessageId } },
      ).catch(() => {});
      return true;
    }
    answer = { value: n };
  } else if (qType === 'choice' && record.question['allowCustom']) {
    // Free-form custom answer for a choice question with allowCustom enabled.
    answer = { value: null, custom_value: trimmed };
  } else if (qType === 'multi_choice') {
    const choices = Array.isArray(record.question['choices'])
      ? record.question['choices'] as string[]
      : [];
    const parts = trimmed.split(',').map(s => s.trim());
    const isNumericList = parts.every(p => {
      const idx = parseInt(p, 10);
      return Number.isInteger(idx) && String(idx) === p && idx >= 1 && idx <= choices.length;
    });
    if (!isNumericList) {
      if (record.question['allowCustom']) {
        answer = { value: null, custom_value: trimmed };
      } else {
        await bot.telegram.sendMessage(
          chatId,
          `Please reply with comma-separated numbers between 1 and ${choices.length}.`,
          { reply_parameters: { message_id: replyToMessageId } },
        ).catch(() => {});
        return true;
      }
    } else {
      answer = { value: parts.map(p => choices[parseInt(p, 10) - 1]!) };
    }
  } else {
    // text (default)
    answer = { value: trimmed };
  }

  const won = await answerHandoff(taskId, answer, 'telegram', handoffsDir).catch(() => false);
  pendingTextHandoffs.delete(replyToMessageId);

  if (won) {
    const answerLabel = qType === 'number'
      ? String((answer as { value: number }).value)
      : trimmed.length > 50 ? `${trimmed.slice(0, 50)}...` : trimmed;
    await bot.telegram.editMessageText(
      chatId,
      replyToMessageId,
      undefined,
      `Answered: ${answerLabel}`,
    ).catch(() => {});
  } else {
    await bot.telegram.editMessageText(
      chatId, replyToMessageId, undefined,
      'This question was already answered from another surface.',
    ).catch(() => {});
  }
  return true;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Update the HandoffRecord with Telegram route and message ID for restart recovery. */
async function persistRouteAndMessageId(
  record: HandoffRecord,
  chatId: number,
  threadId: number | undefined,
  messageId: number,
  handoffsDir?: string,
): Promise<void> {
  const route: HandoffRoute = { chatId, ...(threadId ? { threadId } : {}) };
  const updated: HandoffRecord = {
    ...record,
    route,
    telegramMessageId: messageId,
  };
  try {
    await writeHandoff(updated, handoffsDir);
  } catch {
    // Best-effort: the handoff still works without route/messageId; restart
    // recovery will just re-send to the default target instead of the original chat.
  }
}

/** Edit a callback-query message to show the answered state and remove the keyboard. */
async function editMessageAnswered(
  ctx: { editMessageText: (text: string, extra?: Record<string, unknown>) => Promise<unknown> },
  answerLabel: string,
): Promise<void> {
  await ctx.editMessageText(
    `Answered: ${answerLabel}`,
    { reply_markup: { inline_keyboard: [] } },
  ).catch(() => {});
}

/**
 * Clear the pending text handoff entry for a given taskId.
 * Called when a handoff expires or is answered via another surface.
 */
export function clearPendingTextHandoff(taskId: string): void {
  for (const [msgId, tid] of pendingTextHandoffs) {
    if (tid === taskId) {
      pendingTextHandoffs.delete(msgId);
    }
  }
}
