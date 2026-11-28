import type { Telegraf } from 'telegraf';
import { findHandoffByTelegramMessage, readHandoff, type HandoffRecord } from '../agent/daemon/handoff-store.js';
import { answerHandoff } from '../agent/daemon/handoff-wiring.js';

export const QUESTION_NOT_OPEN = 'This question is no longer open.';

interface SentQuestion {
  taskId: string;
  questionId: string | null;
  threadId?: number;
}

// In-process fallback covers replies that arrive before delivery metadata is
// persisted. Message IDs are unique within a chat, not across chats.
const pendingTextHandoffs = new Map<string, SentQuestion>();
const messageKey = (chatId: number, messageId: number) => `${chatId}:${messageId}`;

export function rememberTextHandoff(chatId: number, messageId: number, question: SentQuestion): void {
  pendingTextHandoffs.set(messageKey(chatId, messageId), question);
}

export function clearPendingTextHandoff(taskId: string): void {
  for (const [key, question] of pendingTextHandoffs) {
    if (question.taskId === taskId) pendingTextHandoffs.delete(key);
  }
}

export function acceptsHandoffTextReply(question: HandoffRecord['question']): boolean {
  return question['type'] !== 'confirm' && (question['type'] !== 'choice' || Boolean(question['allowCustom']));
}

type ParsedAnswer = { answer: { value: string | number | unknown[] } | { value: null; custom_value: string }; label: string }
  | { correction: string };

function parseAnswer(question: HandoffRecord['question'], text: string): ParsedAnswer {
  if (!text) return { correction: 'Please reply with an answer.' };
  switch (question['type']) {
    case 'number': {
      const value = Number(text);
      const min = question['min'];
      const max = question['max'];
      if (!Number.isFinite(value)) return { correction: 'Please reply with a valid number.' };
      if (typeof min === 'number' && value < min) return { correction: `Please reply with a number >= ${min}.` };
      if (typeof max === 'number' && value > max) return { correction: `Please reply with a number <= ${max}.` };
      return { answer: { value }, label: String(value) };
    }
    case 'multi_choice': {
      const choices: unknown[] = Array.isArray(question['choices']) ? question['choices'] : [];
      const parts = text.split(',').map((part) => part.trim());
      const indices = parts.map(Number);
      if (indices.every((n, i) => Number.isInteger(n) && String(n) === parts[i] && n >= 1 && n <= choices.length)) {
        return { answer: { value: indices.map((n) => choices[n - 1]) }, label: text };
      }
      if (!question['allowCustom']) {
        return { correction: `Please reply with comma-separated numbers between 1 and ${choices.length}.` };
      }
      return { answer: { value: null, custom_value: text }, label: text };
    }
    case 'choice':
      return { answer: { value: null, custom_value: text }, label: text };
    default:
      return { answer: { value: text }, label: text };
  }
}

function isOpen(record: HandoffRecord | null | undefined, questionId: string | null): record is HandoffRecord {
  return record?.status === 'pending' && (record.questionId ?? null) === questionId;
}

/** Consume only explicit replies recognized by the in-process cache or store. */
export async function matchReplyToHandoff(
  bot: Telegraf,
  chatId: number,
  replyToMessageId: number,
  text: string,
  handoffsDir?: string,
  fromUser?: { id: number; username?: string },
  replyThreadId?: number,
): Promise<boolean> {
  const key = messageKey(chatId, replyToMessageId);
  const cached = pendingTextHandoffs.get(key);

  // Fix: a stale cache entry must not silently block the durable-store fallback.
  // If cached is present but the live record is no longer open (e.g. question was
  // replaced), evict the stale entry and fall through to findHandoffByTelegramMessage
  // so the durable store can resolve the current delivery (correctness: M).
  let effectiveCached = cached;
  if (cached) {
    const liveRecord = await readHandoff(cached.taskId, handoffsDir);
    if (!isOpen(liveRecord, cached.questionId)) {
      if (pendingTextHandoffs.get(key) === cached) pendingTextHandoffs.delete(key);
      effectiveCached = undefined;
    }
  }

  const saved = effectiveCached ? undefined : await findHandoffByTelegramMessage(chatId, replyToMessageId, handoffsDir);
  const delivery = effectiveCached ?? saved;
  if (!delivery) return false;

  const record = effectiveCached ? await readHandoff(effectiveCached.taskId, handoffsDir) : saved?.record;
  const questionId = delivery.questionId;
  const threadId = delivery.threadId ?? replyThreadId;
  const sendNotice = (notice: string) => bot.telegram.sendMessage(chatId, notice, {
    ...(threadId ? { message_thread_id: threadId } : {}),
    reply_parameters: { message_id: replyToMessageId },
  }).catch(() => {});

  if (!isOpen(record, questionId)) {
    if (effectiveCached && pendingTextHandoffs.get(key) === effectiveCached) pendingTextHandoffs.delete(key);
    await sendNotice(QUESTION_NOT_OPEN);
    return true;
  }
  if (!acceptsHandoffTextReply(record.question)) return false;

  const parsed = parseAnswer(record.question, text.trim());
  if ('correction' in parsed) {
    await sendNotice(parsed.correction);
    return true;
  }

  const responderIdentity = fromUser && (fromUser.username ? `${fromUser.id}:${fromUser.username}` : String(fromUser.id));
  // Recheck the delivered identity under the store's task lock at answer time.
  const won = await answerHandoff(
    record.taskId, parsed.answer, 'telegram', handoffsDir, responderIdentity, questionId,
  ).catch(() => false);
  if (!won) {
    const fresh = await readHandoff(record.taskId, handoffsDir).catch(() => undefined);
    await sendNotice(fresh === undefined || isOpen(fresh, questionId)
      ? 'Could not record the answer. Please try again.'
      : QUESTION_NOT_OPEN);
    return true;
  }

  if (effectiveCached) {
    if (pendingTextHandoffs.get(key) === effectiveCached) pendingTextHandoffs.delete(key);
    // Preserve the existing visual closure for co-hosted prompts when Telegram
    // permits editing; a ForceReply prompt may not be editable.
    const label = parsed.label.length > 50 ? `${parsed.label.slice(0, 50)}...` : parsed.label;
    const edited = await bot.telegram.editMessageText(chatId, replyToMessageId, undefined, `Answered: ${label}`)
      .catch(() => false);
    if (edited) return true;
  }
  await sendNotice('Answer recorded.');
  return true;
}
