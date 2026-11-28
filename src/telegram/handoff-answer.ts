/** Send durable daemon handoff questions and handle Telegram inline-button answers. */

import type { Telegraf } from 'telegraf';
import { answerHandoff } from '../agent/daemon/handoff-wiring.js';
import {
  type HandoffRecord,
  listPendingHandoffs,
  readHandoff,
  updateHandoffMessage,
} from '../agent/daemon/handoff-store.js';
import { parseHandoffCallback, HANDOFF_CALLBACK_PREFIX } from './handoff-callback-data.js';
import { buildHandoffReplyMarkup } from './handoff-reply-markup.js';
import { escapeHtml } from './formatter.js';
import { escapeRegExp } from '../utils/regexp.js';
import { errorMessage } from '../utils/errors.js';
import { palette } from '../cli/palette.js';

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

/**
 * In-memory index of questionId → taskId for new-format (`afk:h:q:…`) buttons.
 * Populated in sendHandoffQuestion so button taps can call readHandoff(taskId)
 * directly — O(1) — instead of listPendingHandoffs() — O(N) disk reads.
 *
 * Invariant: this map is ephemeral — rebuilt via recoverPendingHandoffs on
 * bot restart. On a cold-restart cache miss the handler falls back to the
 * directory scan as a safety net.
 */
const questionIdToTaskId = new Map<string, string>();

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
    const allowCustom = Boolean(question['allowCustom']);
    const replyMarkup = buildHandoffReplyMarkup(qType, record, choices);
    const acceptsTextReply = qType !== 'confirm' && (qType !== 'choice' || allowCustom);
    if (qType === 'choice') {
      if (allowCustom) {
        displayText += '\n\n<i>Or reply to this message with a custom answer</i>';
      }
    } else if (qType === 'multi_choice' && choices.length > 0) {
      const choiceList = choices.map((c, i) => `${i + 1}. ${escapeHtml(String(c))}`).join('\n');
      const hint = allowCustom
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
    } else if (acceptsTextReply) {
      displayText += '\n\n<i>Reply to this message with your answer</i>';
    }

    const sent = await bot.telegram.sendMessage(chatId, displayText, {
      parse_mode: 'HTML',
      ...threadOpts,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    if (acceptsTextReply) pendingTextHandoffs.set(sent.message_id, record.taskId);
    if (record.questionId) questionIdToTaskId.set(record.questionId, record.taskId);
    const route = { chatId, ...(threadId ? { threadId } : {}) };
    // Best effort: restart recovery can fall back to its default route.
    await updateHandoffMessage(record.taskId, record.questionId ?? null, route, sent.message_id, handoffsDir)
      .catch(() => {});
    return { ok: true, messageId: sent.message_id };
  } catch (err) {
    console.error(palette.error(`[handoff-answer] failed to send question for task ${record.taskId}: ${errorMessage(err)}`),
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
  const wildcardRe = new RegExp(`^${escapeRegExp(HANDOFF_CALLBACK_PREFIX)}(?:q:)?\\d+:.+$`);

  bot.action(wildcardRe, async (ctx) => {
    const query = ctx.callbackQuery;
    const parsed = parseHandoffCallback(query && 'data' in query ? query.data : undefined);
    if (!parsed) {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }

    const { choiceIndex } = parsed;
    const expectedQuestionId = 'questionId' in parsed ? parsed.questionId : null;
    // Resolve taskId for new-format buttons via the in-memory index (O(1)).
    // Fall back to a full directory scan only on a cold-restart cache miss,
    // then populate the index for subsequent taps on the same question.
    let record: HandoffRecord | null | undefined;
    if ('taskId' in parsed) {
      record = await readHandoff(parsed.taskId);
    } else {
      const cachedTaskId = questionIdToTaskId.get(parsed.questionId);
      if (cachedTaskId !== undefined) {
        record = await readHandoff(cachedTaskId);
      } else {
        const found = (await listPendingHandoffs()).find(
          (candidate) => candidate.questionId === parsed.questionId,
        );
        if (found) {
          questionIdToTaskId.set(parsed.questionId, found.taskId);
        }
        record = found;
      }
    }
    if (record?.status !== 'pending' || record.questionId !== (expectedQuestionId ?? undefined)) {
      await ctx.answerCbQuery(QUESTION_NOT_OPEN).catch(() => {});
      await editClosedMessage(ctx, QUESTION_NOT_OPEN);
      return;
    }

    const qType = record.question['type'];
    let value: string | boolean;
    let answerLabel: string;
    if (qType === 'confirm' && (choiceIndex === 0 || choiceIndex === 1)) {
      value = choiceIndex === 1;
      answerLabel = value ? 'Yes' : 'No';
    } else if (qType === 'choice' && Array.isArray(record.question['choices'])) {
      const selected: unknown = record.question['choices'][choiceIndex];
      if (typeof selected !== 'string') {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }
      value = answerLabel = selected;
    } else {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }

    const from = query?.from;
    const responderIdentity = from && (from.username ? `${from.id}:${from.username}` : String(from.id));
    // The store compares the expected ID again under the write lock, so a
    // replacement between lookup and answer cannot receive the old answer.
    const won = await answerHandoff(
      record.taskId, { value }, 'telegram', undefined, responderIdentity, expectedQuestionId,
    ).catch(() => false);
    if (won) {
      await ctx.answerCbQuery().catch(() => {});
      await editClosedMessage(ctx, `Answered: ${answerLabel}`);
      return;
    }

    // A busy lock (e.g. while saving delivery metadata) need not mean the
    // question closed. Leave a still-current keyboard available for retry.
    const fresh = await readHandoff(record.taskId).catch(() => undefined);
    if (fresh === undefined || (fresh?.status === 'pending' && fresh.questionId === record.questionId)) {
      await ctx.answerCbQuery('Could not record the answer. Please try again.').catch(() => {});
      return;
    }
    await ctx.answerCbQuery(QUESTION_NOT_OPEN).catch(() => {});
    await editClosedMessage(ctx, QUESTION_NOT_OPEN);
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
 * @param fromUser - Optional Telegram sender identity for provenance recording.
 * @returns true if the reply was matched and consumed as a handoff answer.
 */
export async function matchReplyToHandoff(
  bot: Telegraf,
  chatId: number,
  replyToMessageId: number,
  text: string,
  handoffsDir?: string,
  fromUser?: { id: number; username?: string },
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

  const responderIdentity = fromUser !== undefined
    ? (fromUser.username ? `${fromUser.id}:${fromUser.username}` : String(fromUser.id))
    : undefined;
  const won = await answerHandoff(taskId, answer, 'telegram', handoffsDir, responderIdentity).catch(() => false);
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

const QUESTION_NOT_OPEN = 'This question is no longer open.';

/** Edit a callback-query message and explicitly remove its inline keyboard. */
async function editClosedMessage(
  ctx: { editMessageText: (text: string, extra?: Record<string, unknown>) => Promise<unknown> },
  text: string,
): Promise<void> {
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
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
