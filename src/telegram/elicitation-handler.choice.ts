/**
 * Confirm/choice (inline-keyboard) elicitation handler for Telegram.
 *
 * Extracted from elicitation-handler.ts to keep that file under the
 * 350-code-line ceiling (issue #1865).
 *
 * Design contract:
 *   - All handlers receive EXPLICIT parameters; no closures over factory locals.
 *   - `guard.resolved` is the resolve-once flag, shared via object reference.
 *   - H3: dispatch table (`pendingChoiceElicitations`) is keyed by cryptographically
 *     random elicitId; entries deleted synchronously on resolve or abort.
 *   - H1: abort listener re-attached after every re-arm (`guard.resolved = false`).
 *
 * @module telegram/elicitation-handler.choice
 */

import { Markup } from 'telegraf';
import type { Telegraf } from 'telegraf';
import type { ElicitationRequest, ElicitationResult } from '../agent/types/sdk-types.js';
import {
  buildElicitationCallback,
  buildCustomElicitationCallback,
} from './elicitation-callback-data.js';
import { prepareChoiceRender } from './elicitation-handler.render.js';
import { sendChoiceMessages } from './elicitation-handler.send.js';
import { CUSTOM_ENTRY_SENTINEL_INDEX } from './elicitation-handler.types.js';

/** Minimal shape of the dispatch table entry. */
export interface ChoiceResolver {
  chatId: number;
  resolve: (choiceIndex: number) => void;
}

export interface ChoiceElicitationCtx {
  chatId: number;
  threadOpts: object;
  request: ElicitationRequest;
  signal: AbortSignal;
  bot: Telegraf;
  elicitId: string;
  pendingChoiceElicitations: Map<string, ChoiceResolver>;
  setPending: (resolver: (text: string) => void) => void;
  deletePending: () => void;
}

// ---------------------------------------------------------------------------
// Internal: resolve the confirm/choice result from a button index
// ---------------------------------------------------------------------------

function resolveChoiceResult(
  choiceIndex: number,
  qType: string,
  request: ElicitationRequest,
): ElicitationResult {
  if (qType === 'confirm') {
    // index 1 = Yes, index 0 = No
    return { action: 'accept', content: { value: choiceIndex === 1 } };
  }
  const choices = request.choices ?? [];
  const selected = choices[choiceIndex];
  if (selected === undefined) return { action: 'decline' };
  return { action: 'accept', content: { value: selected } };
}

// ---------------------------------------------------------------------------
// Public: confirm/choice elicitation Promise
// ---------------------------------------------------------------------------

/**
 * Handle a confirm or choice (inline-keyboard) elicitation.
 *
 * All mutable state is passed explicitly; no closures over factory-level locals.
 */
export function handleChoiceElicitation(
  ctx: ChoiceElicitationCtx,
  qType: string,
  displayText: string,
): Promise<ElicitationResult> {
  return new Promise((resolve) => {
    let resolved = false;
    // Set once the custom-entry flow installs a chatId-keyed text intercept.
    // The choice dispatch table is keyed by elicitId; the text intercept by
    // chatId — abort must clear BOTH or a stale handler lingers.
    let inCustomTextWait = false;

    const { chatId, threadOpts, request, signal, bot, elicitId, pendingChoiceElicitations } = ctx;

    const onAbort = () => {
      if (resolved) return;
      resolved = true;
      // H3: clean up the dispatch table entry so the wildcard handler
      // can't fire after the promise is settled.
      pendingChoiceElicitations.delete(elicitId);
      // Custom-entry abort: also drop the chatId-keyed text intercept so a
      // stale handler can't swallow the user's next message.
      if (inCustomTextWait) ctx.deletePending();
      resolve({ action: 'decline' });
    };
    signal.addEventListener('abort', onAbort, { once: true });

    // H3: register a short-lived resolver in the dispatch table.
    pendingChoiceElicitations.set(elicitId, {
      chatId,
      resolve: (choiceIndex: number) => {
        if (resolved) return;
        resolved = true;
        pendingChoiceElicitations.delete(elicitId);
        signal.removeEventListener('abort', onAbort);

        // Custom-entry path: transition to text-intercept mode
        if (choiceIndex === CUSTOM_ENTRY_SENTINEL_INDEX) {
          resolved = false; // re-arm for the text intercept
          inCustomTextWait = true;
          bot.telegram.sendMessage(chatId, '✍️ Please type your custom answer:', threadOpts).catch(() => {});
          if (signal.aborted) { resolve({ action: 'decline' }); return; }
          ctx.setPending((text: string) => {
            if (resolved) return;
            resolved = true;
            signal.removeEventListener('abort', onAbort);
            const trimmed = text.trim();
            if (trimmed === ':cancel') { resolve({ action: 'cancel' }); return; }
            resolve({ action: 'accept', content: { value: null, custom_value: trimmed } });
          });
          // H1: re-attach abort listener so abort during text wait resolves correctly
          signal.addEventListener('abort', onAbort, { once: true });
          return;
        }

        resolve(resolveChoiceResult(choiceIndex, qType, request));
      },
    });

    // Build buttons
    let buttons: ReturnType<typeof Markup.button.callback>[][];
    let choicePreMessages: string[] = [];

    if (qType === 'confirm') {
      buttons = [[
        Markup.button.callback('✅ Yes', buildElicitationCallback(elicitId, 1)),
        Markup.button.callback('❌ No', buildElicitationCallback(elicitId, 0)),
      ]];
    } else {
      // choice — M1/M2/M3: cap, truncate labels, split if over 4096 chars.
      const { choiceMsg, buttons: cb } = prepareChoiceRender(
        request.choices ?? [],
        displayText,
        (i) => buildElicitationCallback(elicitId, i),
      );
      ({ keyboardText: displayText, preMessages: choicePreMessages } = choiceMsg);
      buttons = cb;
      if (request.allowCustom) {
        buttons.push([
          Markup.button.callback('✍️ Type a custom answer', buildCustomElicitationCallback(elicitId)),
        ]);
      }
    }

    // Send pre-messages then keyboard; signal stops pre-sends on abort,
    // failure at either stage declines identically to the prior behaviour.
    sendChoiceMessages(
      bot.telegram, chatId,
      choicePreMessages, displayText,
      threadOpts, { reply_markup: Markup.inlineKeyboard(buttons).reply_markup },
      () => {
        if (!resolved) {
          resolved = true;
          pendingChoiceElicitations.delete(elicitId);
          signal.removeEventListener('abort', onAbort);
          resolve({ action: 'decline' });
        }
      },
      signal,
    );
  });
}
