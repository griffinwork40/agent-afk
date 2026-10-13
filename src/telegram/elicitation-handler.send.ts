import { TELEGRAM_MAX_CHARS } from './elicitation-choice-list.js';

/**
 * Split a prompt that exceeds TELEGRAM_MAX_CHARS into chunks each ≤ maxLen.
 * Splits on the last newline within the window so message boundaries fall at
 * natural paragraph breaks where possible. Falls back to a hard character split
 * when no newline is present.
 *
 * Returns an array of at least one element. The caller sends all but the last
 * chunk as plain pre-messages, then sends the last chunk as the interceptable
 * prompt message (so only one message requires the user's reply).
 *
 * Fix (issue #3631, item 3).
 */
export function splitLongPrompt(prompt: string, maxLen: number = TELEGRAM_MAX_CHARS): string[] {
  if (prompt.length <= maxLen) return [prompt];

  const chunks: string[] = [];
  let remaining = prompt;

  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    const nlIdx = window.lastIndexOf('\n');
    const splitAt = nlIdx > 0 ? nlIdx : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt === nlIdx ? splitAt + 1 : splitAt);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Low-level send helper for Telegram choice elicitations.
 *
 * Extracted from elicitation-handler.ts to keep that file under the
 * 350-code-line ceiling (issue #3631).
 *
 * @module telegram/elicitation-handler.send
 */

/**
 * Send the choice pre-messages (if any) and then the keyboard message.
 * If any send fails, `onFailure` is called once.
 *
 * Fix (issue #3631, items 4 & 5):
 *   - Accepts `signal` and short-circuits once aborted (no keyboard sent
 *     after abort during pre-sends).
 *   - `console.warn`s send failures before calling `onFailure`, matching
 *     the text-path log prefix `[elicitation-handler]`.
 */
export function sendChoiceMessages(
  telegram: { sendMessage: (chatId: number, text: string, opts: object) => Promise<unknown> },
  chatId: number,
  preMessages: string[],
  keyboardText: string,
  threadOpts: object,
  keyboardOpts: object,
  onFailure: () => void,
  signal?: AbortSignal,
): void {
  const sendKeyboard = () => {
    if (signal?.aborted) return;
    telegram
      .sendMessage(chatId, keyboardText, { parse_mode: 'HTML', ...threadOpts, ...keyboardOpts })
      .catch((err: unknown) => {
        console.warn(
          '[elicitation-handler] keyboard sendMessage failed; declining elicitation for chat',
          chatId,
          err,
        );
        onFailure();
      });
  };

  if (preMessages.length === 0) {
    sendKeyboard();
    return;
  }

  const sendPre = async () => {
    for (const msg of preMessages) {
      if (signal?.aborted) return;
      await telegram.sendMessage(chatId, msg, { parse_mode: 'HTML', ...threadOpts });
    }
  };

  sendPre().then(sendKeyboard).catch((err: unknown) => {
    console.warn(
      '[elicitation-handler] pre-message sendMessage failed; declining elicitation for chat',
      chatId,
      err,
    );
    onFailure();
  });
}
