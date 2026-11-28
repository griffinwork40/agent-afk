import { buildHandoffReplyMarkup, operatorNotify } from '../operator-notify.js';
import { errorMessage } from '../../utils/errors.js';
import { updateHandoffMessage, type HandoffRecord } from './handoff-store.js';

export function truncateHandoffNotice(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 300)}…(truncated)`;
}

/** Send a raw handoff push and keep each successful chunk addressable by reply. */
export async function pushHandoffQuestion(
  record: HandoffRecord,
  text: string,
  opts: { target?: number; messageThreadId?: number; handoffsDir?: string } = {},
): Promise<boolean> {
  if (record.notifyOn === 'never') return false;
  const { question } = record;
  const qType = typeof question['type'] === 'string' ? question['type'] : 'text';
  const choices = Array.isArray(question['choices']) ? question['choices'].map(String) : [];
  const replyMarkup = buildHandoffReplyMarkup(qType, record, choices);
  const parts = [text];
  if (qType === 'multi_choice' && choices.length > 0) {
    parts.push(choices.map((choice, i) => `${i + 1}. ${choice}`).join('\n'));
    parts.push('Reply with comma-separated numbers (e.g. 1,3)' +
      (question['allowCustom'] ? ' or a custom answer.' : '.'));
  } else if (!replyMarkup && choices.length > 0) {
    parts.push(`Options: ${truncateHandoffNotice(choices.join(', '))}`);
  }
  if (qType === 'number') {
    const min = question['min'];
    const max = question['max'];
    const bounds = [typeof min === 'number' ? `>= ${min}` : '', typeof max === 'number' ? `<= ${max}` : ''];
    parts.push(`Reply with a number${bounds.some(Boolean) ? ` (${bounds.filter(Boolean).join(', ')})` : ''}.`);
  } else if (qType === 'text') {
    parts.push('Reply to this message with your answer.');
  } else if (qType === 'choice' && question['allowCustom']) {
    parts.push('Or reply to this message with a custom answer.');
  }

  const results = await operatorNotify(parts.join('\n'), {
    captureDelivery: true,
    ...(replyMarkup !== undefined ? { replyMarkup } : {}),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.messageThreadId !== undefined ? { messageThreadId: opts.messageThreadId } : {}),
  });
  if (!results?.length) return false;
  for (const result of results) {
    if (!result.ok || !result.delivery) continue;
    const { messageId, ...route } = result.delivery;
    try {
      await updateHandoffMessage(record.taskId, record.questionId ?? null, route, messageId, opts.handoffsDir, {
        preserveRoute: true,
      });
    } catch (err) {
      console.error('[handoff-notify] could not save Telegram delivery for task %s: %s', record.taskId, errorMessage(err));
    }
  }
  return results.every((result) => result.ok);
}
