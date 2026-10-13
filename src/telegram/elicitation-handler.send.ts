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
): Promise<void> {
  const sendKeyboard = (): Promise<void> => {
    if (signal?.aborted) return Promise.resolve();
    return telegram
      .sendMessage(chatId, keyboardText, { parse_mode: 'HTML', ...threadOpts, ...keyboardOpts })
      .then(() => undefined)
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
    return sendKeyboard();
  }

  const sendPre = async () => {
    for (const msg of preMessages) {
      if (signal?.aborted) return;
      await telegram.sendMessage(chatId, msg, { parse_mode: 'HTML', ...threadOpts });
    }
  };

  return sendPre().then(sendKeyboard).catch((err: unknown) => {
    console.warn(
      '[elicitation-handler] pre-message sendMessage failed; declining elicitation for chat',
      chatId,
      err,
    );
    onFailure();
  });
}
