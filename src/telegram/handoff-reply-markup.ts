import type { InlineKeyboardMarkup } from 'telegraf/types';
import type { HandoffRecord } from '../agent/daemon/handoff-store.js';
import { truncateTelegramLabel } from '../utils/truncate-telegram-label.js';
import { buildHandoffCallback } from './handoff-callback-data.js';

/** Build the same confirm/choice keyboard for raw pushes and Telegraf sends. */
export function buildHandoffReplyMarkup(
  qType: string,
  record: Pick<HandoffRecord, 'taskId' | 'questionId'>,
  choices?: readonly string[],
): InlineKeyboardMarkup | undefined {
  try {
    if (qType === 'confirm') {
      return {
        inline_keyboard: [[
          { text: 'Yes', callback_data: buildHandoffCallback(record, 1) },
          { text: 'No', callback_data: buildHandoffCallback(record, 0) },
        ]],
      };
    }
    if (qType === 'choice' && choices && choices.length > 0) {
      const MAX_CHOICES = 20;
      return {
        inline_keyboard: choices.slice(0, MAX_CHOICES).map((choice, index) => [{
          text: truncateTelegramLabel(String(choice)),
          callback_data: buildHandoffCallback(record, index),
        }]),
      };
    }
  } catch (error) {
    if (record.questionId !== undefined) throw error;
    // A legacy task ID may not fit; preserve the question as a plain message.
  }
  return undefined;
}
