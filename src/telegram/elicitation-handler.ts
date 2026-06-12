/**
 * Telegram-backed elicitation handler for `ask_question` requests.
 *
 * Routes agent-originated questions to the Telegram chat. For
 * `choice`/`confirm` types, sends inline keyboard buttons. For
 * `text`/`number`/`multi_choice` types, sends a plain message and
 * intercepts the next plain-text reply via `messageHandler.pendingElicitations`.
 *
 * Design contract:
 *   - `ctx.answerCbQuery()` is called BEFORE resolving the promise so
 *     Telegram's spinner is cleared immediately.
 *   - Abort signal → `{ action: 'decline' }`.
 *   - User types `:cancel` → `{ action: 'cancel' }`.
 *   - `allow_skip` + empty input → `{ action: 'skip' }`.
 *   - A single wildcard `bot.action` is registered once in the factory body
 *     and routes to a short-lived `Map<id, resolver>` (H3: no per-question
 *     Telegraf closure accumulation).
 *
 * @module telegram/elicitation-handler
 */

import { Markup, Telegraf } from 'telegraf';
import type { ElicitationHandler } from '../agent/elicitation-router.js';
import type { ElicitationRequest, ElicitationResult } from '../agent/types/sdk-types.js';
import type { MessageHandler } from './handlers/message.js';
import {
  buildElicitationCallback,
  parseElicitationCallback,
  ELICITATION_CALLBACK_PREFIX,
  buildCustomElicitationCallback,
  parseCustomElicitationCallback,
  ELICITATION_CUSTOM_CALLBACK_PREFIX,
} from './elicitation-callback-data.js';
import { randomBytes } from 'node:crypto';
import { escapeHtml } from './formatter.js';

function nextElicitationId(): string {
  return `elic-${randomBytes(8).toString('hex')}`;
}

/** Inline regex escape helper (same pattern as bot.ts). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Sentinel returned by the custom-entry wildcard handler to the dispatch table. */
const CUSTOM_ENTRY_SENTINEL_INDEX = -1;

/**
 * Truncate a button label to Telegram's ~64-byte UTF-8 limit.
 * Uses Buffer to count bytes correctly for multi-byte codepoints
 * and slices without splitting a multi-byte sequence mid-codepoint.
 *
 * M2: choice labels are agent-controlled and can exceed 64 bytes;
 * overflowing Telegram's limit causes sendMessage to return a 400
 * that the `.catch` swallows, silently resolving `decline`.
 */
function truncateLabel(label: string, maxBytes = 64): string {
  if (Buffer.byteLength(label, 'utf8') <= maxBytes) return label;
  const buf = Buffer.from(label, 'utf8').subarray(0, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/\uFFFD$/, '');
}

/**
 * Build a Telegram elicitation handler.
 *
 * The factory registers ONE wildcard `bot.action` for the lifetime of the
 * bot instance. Per-elicitation resolvers are stored in `pendingChoiceElicitations`
 * and deleted on resolve or abort — keeping the Telegraf middleware chain O(1).
 *
 * @param messageHandler - The message handler instance (for `pendingElicitations`).
 * @param bot - The Telegraf bot instance (for `bot.action` registration).
 * @param chatId - The Telegram chat ID to send questions to.
 */
export function makeTelegramElicitationHandler(
  messageHandler: MessageHandler,
  bot: Telegraf,
  chatId: number,
): ElicitationHandler {
  /**
   * H3: Single dispatch table for confirm/choice elicitations.
   * Keys are elicitation IDs; values are `(choiceIndex) => void` resolvers.
   * Entries are deleted synchronously on resolve or abort.
   */
  const pendingChoiceElicitations = new Map<string, (choiceIndex: number) => void>();

  /**
   * H3: One wildcard action handler registered once.
   * All confirm/choice button presses route through here.
   */
  const wildcardRe = new RegExp(`^${escapeRegExp(ELICITATION_CALLBACK_PREFIX)}\\d+:.+$`);
  bot.action(wildcardRe, async (ctx) => {
    // Answer the callback query FIRST to clear Telegram's spinner.
    await ctx.answerCbQuery().catch(() => {});
    // Defence-in-depth: reject cross-chat replays.
    if (ctx.chat?.id !== chatId) return;

    const callbackData =
      typeof ctx.callbackQuery === 'object' && 'data' in ctx.callbackQuery
        ? (ctx.callbackQuery as { data: string }).data
        : undefined;
    const parsed = parseElicitationCallback(callbackData);
    if (!parsed) return;

    const resolver = pendingChoiceElicitations.get(parsed.id);
    if (resolver) resolver(parsed.choiceIndex);
  });

  const customWildcardRe = new RegExp(`^${escapeRegExp(ELICITATION_CUSTOM_CALLBACK_PREFIX)}.+$`);
  bot.action(customWildcardRe, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (ctx.chat?.id !== chatId) return;
    const callbackData =
      typeof ctx.callbackQuery === 'object' && 'data' in ctx.callbackQuery
        ? (ctx.callbackQuery as { data: string }).data
        : undefined;
    const id = parseCustomElicitationCallback(callbackData);
    if (!id) return;
    const resolver = pendingChoiceElicitations.get(id);
    if (resolver) resolver(CUSTOM_ENTRY_SENTINEL_INDEX);
  });

  return async (
    request: ElicitationRequest,
    options: { signal: AbortSignal },
  ): Promise<ElicitationResult> => {
    if (options.signal.aborted) return { action: 'decline' };

    const qType = request.type ?? 'text';
    const questionText = request.message;

    // Build display text
    let displayText = `💬 <b>Question from agent</b>\n\n${escapeHtml(questionText)}`;
    if (request.context) {
      displayText = `💬 <b>Question from agent</b>\n\n<i>${escapeHtml(request.context)}</i>\n\n${escapeHtml(questionText)}`;
    }

    if (qType === 'confirm' || qType === 'choice') {
      // Use inline keyboard routed through the single wildcard dispatcher (H3).
      const elicitId = nextElicitationId();

      let buttons: ReturnType<typeof Markup.button.callback>[][];
      if (qType === 'confirm') {
        buttons = [[
          Markup.button.callback('✅ Yes', buildElicitationCallback(elicitId, 1)),
          Markup.button.callback('❌ No', buildElicitationCallback(elicitId, 0)),
        ]];
      } else {
        // choice — M1: cap to 20 items to avoid Telegram API 400 on oversized
        // keyboards (Telegram silently rejects messages with too many buttons).
        // M2: truncate labels to Telegram's ~64-byte limit.
        const MAX_CHOICES = 20;
        const choices = (request.choices ?? []).slice(0, MAX_CHOICES);
        buttons = choices.map((choice, i) => [
          Markup.button.callback(truncateLabel(choice), buildElicitationCallback(elicitId, i)),
        ]);
        if (request.allowCustom) {
          buttons.push([
            Markup.button.callback('✍️ Type a custom answer', buildCustomElicitationCallback(elicitId)),
          ]);
        }
      }

      return new Promise<ElicitationResult>((resolve) => {
        let resolved = false;
        // Set once the custom-entry flow installs a chatId-keyed text intercept.
        // The choice dispatch table is keyed by elicitId; the text intercept by
        // chatId — abort must clear BOTH or a stale handler lingers.
        let inCustomTextWait = false;

        const onAbort = () => {
          if (resolved) return;
          resolved = true;
          // H3: clean up the dispatch table entry so the wildcard handler
          // can't fire after the promise is settled.
          pendingChoiceElicitations.delete(elicitId);
          // Custom-entry abort: also drop the chatId-keyed text intercept so a
          // stale handler can't swallow the user's next message.
          if (inCustomTextWait) messageHandler.pendingElicitations.delete(chatId);
          resolve({ action: 'decline' });
        };
        options.signal.addEventListener('abort', onAbort, { once: true });

        // H3: register a short-lived resolver in the dispatch table.
        pendingChoiceElicitations.set(elicitId, (choiceIndex: number) => {
          if (resolved) return;
          resolved = true;
          pendingChoiceElicitations.delete(elicitId);
          options.signal.removeEventListener('abort', onAbort);

          // Custom-entry path: transition to text-intercept mode
          if (choiceIndex === CUSTOM_ENTRY_SENTINEL_INDEX) {
            resolved = false; // re-arm for the text intercept
            inCustomTextWait = true;
            bot.telegram.sendMessage(chatId, '✍️ Please type your custom answer:').catch(() => {});
            if (options.signal.aborted) { resolve({ action: 'decline' }); return; }
            messageHandler.pendingElicitations.set(chatId, (text: string) => {
              if (resolved) return;
              resolved = true;
              options.signal.removeEventListener('abort', onAbort);
              const trimmed = text.trim();
              if (trimmed === ':cancel') { resolve({ action: 'cancel' }); return; }
              resolve({ action: 'accept', content: { value: null, custom_value: trimmed } });
            });
            // H1: re-attach abort listener so abort during text wait resolves correctly
            options.signal.addEventListener('abort', onAbort, { once: true });
            return;
          }

          if (qType === 'confirm') {
            // index 1 = Yes, index 0 = No
            resolve({ action: 'accept', content: { value: choiceIndex === 1 } });
          } else {
            const choices = request.choices ?? [];
            const selected = choices[choiceIndex];
            if (selected === undefined) {
              resolve({ action: 'decline' });
            } else {
              resolve({ action: 'accept', content: { value: selected } });
            }
          }
        });

        // Send the keyboard message
        bot.telegram.sendMessage(chatId, displayText, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }).catch(() => {
          if (!resolved) {
            resolved = true;
            pendingChoiceElicitations.delete(elicitId);
            options.signal.removeEventListener('abort', onAbort);
            resolve({ action: 'decline' });
          }
        });
      });
    }

    // text / number / multi_choice — plain message + intercept next reply
    return new Promise<ElicitationResult>((resolve) => {
      let resolved = false;

      const onAbort = () => {
        if (resolved) return;
        resolved = true;
        // M6: log abandoned-entry cleanup so diagnostic traces surface if the
        // re-prompt race (H1) or an unanticipated path leaves a stale entry.
        if (messageHandler.pendingElicitations.has(chatId)) {
          console.warn('[elicitation-handler] abort: cleaning up stale pendingElicitation for chatId', chatId);
        }
        messageHandler.pendingElicitations.delete(chatId);
        resolve({ action: 'decline' });
      };
      options.signal.addEventListener('abort', onAbort, { once: true });

      // isFirstPrompt tracks whether this is the initial prompt (true) or a re-prompt
      // after invalid input (false). The :cancel hint is only shown on the first prompt
      // to avoid cluttering every validation error re-prompt.
      let isFirstPrompt = true;

      function handleText(text: string): void {
        if (resolved) return;
        resolved = true;
        options.signal.removeEventListener('abort', onAbort);

        const trimmed = text.trim();
        if (trimmed === ':cancel') {
          resolve({ action: 'cancel' });
          return;
        }
        if (trimmed === '' && request.allowSkip) {
          resolve({ action: 'skip' });
          return;
        }

        if (qType === 'number') {
          // Contract: empty input on a required number question must re-prompt, not silently
          // accept Number('') === 0. Without this guard, an accidental empty Telegram message
          // is forwarded to the agent as a deliberate `0` answer.
          if (trimmed === '' && !request.allowSkip) {
            resolved = false;
            isFirstPrompt = false;
            bot.telegram.sendMessage(chatId, '❌ Please enter a number.').catch(() => {});
            // H1: abort guard — if abort fired between `resolved = false` and `.set()`,
            // the promise is already settled; skip re-registration to avoid a dangling intercept.
            if (options.signal.aborted) return;
            messageHandler.pendingElicitations.set(chatId, handleText);
            // H1: re-attach abort listener so abort during the next wait resolves the promise.
            options.signal.addEventListener('abort', onAbort, { once: true });
            return;
          }
          const n = Number(trimmed);
          if (!isFinite(n)) {
            // Re-prompt: re-register and ask again
            resolved = false;
            isFirstPrompt = false;
            bot.telegram.sendMessage(chatId, '❌ Please enter a valid number.').catch(() => {});
            // H1: abort guard before re-registration.
            if (options.signal.aborted) return;
            messageHandler.pendingElicitations.set(chatId, handleText);
            // H1: re-attach abort listener for the next wait.
            options.signal.addEventListener('abort', onAbort, { once: true });
            return;
          }
          if (request.min !== undefined && n < request.min) {
            resolved = false;
            isFirstPrompt = false;
            bot.telegram.sendMessage(chatId, `❌ Value must be ≥ ${request.min}.`).catch(() => {});
            // H1: abort guard before re-registration.
            if (options.signal.aborted) return;
            messageHandler.pendingElicitations.set(chatId, handleText);
            // H1: re-attach abort listener for the next wait.
            options.signal.addEventListener('abort', onAbort, { once: true });
            return;
          }
          if (request.max !== undefined && n > request.max) {
            resolved = false;
            isFirstPrompt = false;
            bot.telegram.sendMessage(chatId, `❌ Value must be ≤ ${request.max}.`).catch(() => {});
            // H1: abort guard before re-registration.
            if (options.signal.aborted) return;
            messageHandler.pendingElicitations.set(chatId, handleText);
            // H1: re-attach abort listener for the next wait.
            options.signal.addEventListener('abort', onAbort, { once: true });
            return;
          }
          resolve({ action: 'accept', content: { value: n } });
          return;
        }

        if (qType === 'multi_choice') {
          const choices = request.choices ?? [];

          // allow_custom: non-numeric, non-empty, non-cancel text on multi_choice is a custom answer
          if (request.allowCustom) {
            const firstPart = trimmed.split(',')[0]?.trim() ?? '';
            const parsedFirst = parseInt(firstPart, 10);
            const looksNumeric = Number.isInteger(parsedFirst) && String(parsedFirst) === firstPart && parsedFirst >= 1 && parsedFirst <= choices.length;
            if (!looksNumeric && trimmed !== '' && trimmed !== ':cancel') {
              resolve({ action: 'accept', content: { value: null, custom_value: trimmed } });
              return;
            }
          }

          const parts = trimmed.split(',').map((s) => s.trim());
          const selected: string[] = [];
          for (const part of parts) {
            const idx = parseInt(part, 10);
            if (!Number.isInteger(idx) || String(idx) !== part || idx < 1 || idx > choices.length) {
              resolved = false;
              isFirstPrompt = false;
              bot.telegram.sendMessage(
                chatId,
                `❌ Invalid selection. Enter comma-separated numbers between 1 and ${choices.length}.`,
              ).catch(() => {});
              // H1: abort guard before re-registration.
              if (options.signal.aborted) return;
              messageHandler.pendingElicitations.set(chatId, handleText);
              // H1: re-attach abort listener for the next wait.
              options.signal.addEventListener('abort', onAbort, { once: true });
              return;
            }
            selected.push(choices[idx - 1]!);
          }
          resolve({ action: 'accept', content: { value: selected } });
          return;
        }

        // text (default)
        if (trimmed === '' && !request.allowSkip) {
          resolved = false;
          isFirstPrompt = false;
          bot.telegram.sendMessage(chatId, '❌ Please enter a response (or type :cancel to skip).').catch(() => {});
          // H1: abort guard before re-registration.
          if (options.signal.aborted) return;
          messageHandler.pendingElicitations.set(chatId, handleText);
          // H1: re-attach abort listener for the next wait.
          options.signal.addEventListener('abort', onAbort, { once: true });
          return;
        }
        resolve({ action: 'accept', content: { value: trimmed } });
      }

      // Register intercept
      messageHandler.pendingElicitations.set(chatId, handleText);

      // Build prompt text
      let promptText = displayText;
      if (qType === 'multi_choice') {
        const choices = request.choices ?? [];
        const choiceList = choices.map((c, i) => `${i + 1}. ${escapeHtml(c)}`).join('\n');
        promptText += `\n\n${choiceList}\n\nEnter comma-separated numbers (e.g. 1,3)`;
        if (request.allowCustom) {
          promptText += '\n\n<i>Or type any free-form text as a custom answer.</i>';
        }
      } else if (qType === 'number') {
        const boundsHint =
          request.min !== undefined && request.max !== undefined
            ? ` (${request.min}–${request.max})`
            : request.min !== undefined
            ? ` (≥${request.min})`
            : request.max !== undefined
            ? ` (≤${request.max})`
            : '';
        promptText += `\n\nEnter a number${boundsHint}`;
      }
      if (isFirstPrompt) {
        if (request.allowSkip) {
          promptText += '\n\n<i>Enter empty to skip, or :cancel to cancel.</i>';
        } else {
          promptText += '\n\n<i>Type :cancel to cancel.</i>';
        }
      }

      bot.telegram.sendMessage(chatId, promptText, { parse_mode: 'HTML' }).catch(() => {
        if (!resolved) {
          resolved = true;
          options.signal.removeEventListener('abort', onAbort);
          // M6: log sendMessage failure so callers can diagnose silent declines
          // without a visible error (e.g., MarkdownV2 parse failure, network error).
          console.warn('[elicitation-handler] sendMessage failed; declining elicitation for chatId', chatId);
          messageHandler.pendingElicitations.delete(chatId);
          resolve({ action: 'decline' });
        }
      });
    });
  };
}
