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
import { acceptsHandoffTextReply, QUESTION_NOT_OPEN, rememberTextHandoff } from './handoff-text-reply.js';
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

export { clearPendingTextHandoff, matchReplyToHandoff } from './handoff-text-reply.js';

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
 * - text/number/multi_choice: ForceReply opens the reply box
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
    const acceptsTextReply = acceptsHandoffTextReply(question);
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
    const route = { chatId, ...(threadId ? { threadId } : {}) };
    const questionId = record.questionId ?? null;
    if (acceptsTextReply) rememberTextHandoff(chatId, sent.message_id, { taskId: record.taskId, questionId, threadId });
    // Best effort: restart recovery can fall back to its default route.
    await updateHandoffMessage(record.taskId, questionId, route, sent.message_id, handoffsDir)
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
    // Read durable state on every tap, including the first one after a restart.
    const record = 'taskId' in parsed
      ? await readHandoff(parsed.taskId)
      : (await listPendingHandoffs()).find((candidate) => candidate.questionId === parsed.questionId);
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

/** Edit a callback-query message and explicitly remove its inline keyboard. */
async function editClosedMessage(
  ctx: { editMessageText: (text: string, extra?: Record<string, unknown>) => Promise<unknown> },
  text: string,
): Promise<void> {
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
}
