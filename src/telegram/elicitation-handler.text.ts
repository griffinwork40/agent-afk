/**
 * Text/number/multi_choice elicitation handlers for Telegram.
 *
 * Extracted from elicitation-handler.ts to keep that file under the
 * 350-code-line ceiling (issue #1865).
 *
 * Design contract:
 *   - All handlers receive EXPLICIT parameters; no closures over enclosing locals.
 *   - `guard.resolved` is the resolve-once flag, shared via the object reference.
 *   - H1: after every `guard.resolved = false` re-arm, callers re-attach the
 *     abort listener and check `signal.aborted` before calling `setPending`.
 *   - Issue #3256: `minLength`/`maxLength` validation for text answers is called
 *     via `validateTextAnswer` in `handleTextReply`. If Telegram text elicitation
 *     ignores those constraints, the fix belongs in `handleTextReply` here.
 *
 * @module telegram/elicitation-handler.text
 */

import { escapeHtml } from './formatter.js';
import { validateTextAnswer, validateNumberAnswer } from '../agent/elicitation/answer-validation.js';
import { palette } from '../cli/palette.js';
import type { ElicitationCtx, ResolveGuard, Resolve } from './elicitation-handler.types.js';
import { splitLongPrompt } from './elicitation-handler.send.js';

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the full prompt text for text/number/multi_choice questions.
 * Pure function; no side effects.
 */
export function buildTextPrompt(
  displayText: string,
  request: ElicitationCtx['request'],
  qType: string,
  isFirstPrompt: boolean,
): string {
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

  return promptText;
}

// ---------------------------------------------------------------------------
// Re-prompt helpers (shared logic: reset guard, send error, re-register)
// ---------------------------------------------------------------------------

/**
 * Re-arm the guard and re-register `handleText` after a validation failure.
 * H1: checks `signal.aborted` before calling `setPending`; caller must
 * re-attach abort listener after this returns true.
 *
 * @returns true if re-registration succeeded, false if already aborted.
 */
function rePrompt(
  errorMsg: string,
  ctx: ElicitationCtx,
  guard: ResolveGuard,
  handleText: (text: string) => void,
): boolean {
  guard.resolved = false;
  ctx.bot.telegram.sendMessage(ctx.chatId, errorMsg, ctx.threadOpts).catch(() => {});
  // H1: abort guard — if abort fired between `resolved = false` and `.set()`,
  // the promise is already settled; skip re-registration to avoid a dangling intercept.
  if (ctx.signal.aborted) return false;
  ctx.setPending(handleText);
  return true;
}

// ---------------------------------------------------------------------------
// Per-type reply handlers
// ---------------------------------------------------------------------------

/**
 * Handle a text reply for a `number` question.
 * Invariant: called only when qType === 'number'.
 */
function handleNumberReply(
  trimmed: string,
  ctx: ElicitationCtx,
  guard: ResolveGuard,
  resolve: Resolve,
  onAbort: () => void,
  handleText: (text: string) => void,
): void {
  // Contract: empty input on a required number question must re-prompt, not silently
  // accept Number('') === 0. Without this guard, an accidental empty Telegram message
  // is forwarded to the agent as a deliberate `0` answer.
  if (trimmed === '' && !ctx.request.allowSkip) {
    if (rePrompt('❌ Please enter a number.', ctx, guard, handleText)) {
      // H1: re-attach abort listener so abort during the next wait resolves the promise.
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    return;
  }
  const numResult = validateNumberAnswer(trimmed, ctx.request);
  if (!numResult.ok) {
    if (rePrompt(`❌ ${numResult.message}`, ctx, guard, handleText)) {
      // H1: re-attach abort listener for the next wait.
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    return;
  }
  resolve({ action: 'accept', content: { value: numResult.value } });
}

/**
 * Handle a text reply for a `multi_choice` question.
 * Invariant: called only when qType === 'multi_choice'.
 */
function handleMultiChoiceReply(
  trimmed: string,
  ctx: ElicitationCtx,
  guard: ResolveGuard,
  resolve: Resolve,
  onAbort: () => void,
  handleText: (text: string) => void,
): void {
  const choices = ctx.request.choices ?? [];

  // allow_custom: non-numeric, non-empty, non-cancel text on multi_choice is a custom answer
  if (ctx.request.allowCustom) {
    const firstPart = trimmed.split(',')[0]?.trim() ?? '';
    const parsedFirst = parseInt(firstPart, 10);
    const looksNumeric =
      Number.isInteger(parsedFirst) &&
      String(parsedFirst) === firstPart &&
      parsedFirst >= 1 &&
      parsedFirst <= choices.length;
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
      if (
        rePrompt(
          `❌ Invalid selection. Enter comma-separated numbers between 1 and ${choices.length}.`,
          ctx,
          guard,
          handleText,
        )
      ) {
        // H1: re-attach abort listener for the next wait.
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
      return;
    }
    selected.push(choices[idx - 1]!);
  }
  resolve({ action: 'accept', content: { value: selected } });
}

/**
 * Handle a text reply for a `text` question.
 * Issue #3256: `minLength`/`maxLength` validation is applied here via
 * `validateTextAnswer`. If Telegram text elicitation ignores those constraints,
 * the fix belongs in this function.
 */
function handlePlainTextReply(
  trimmed: string,
  ctx: ElicitationCtx,
  guard: ResolveGuard,
  resolve: Resolve,
  onAbort: () => void,
  handleText: (text: string) => void,
): void {
  if (trimmed === '' && !ctx.request.allowSkip) {
    if (rePrompt('❌ Please enter a response (or type :cancel to skip).', ctx, guard, handleText)) {
      // H1: re-attach abort listener for the next wait.
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    return;
  }
  // Validate minLength / maxLength constraints (shared with CLI path).
  if (trimmed !== '') {
    const textResult = validateTextAnswer(trimmed, ctx.request);
    if (!textResult.ok) {
      if (rePrompt(`❌ ${textResult.message}`, ctx, guard, handleText)) {
        // H1: re-attach abort listener for the next wait.
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
      return;
    }
  }
  resolve({ action: 'accept', content: { value: trimmed } });
}

// ---------------------------------------------------------------------------
// Public: text/number/multi_choice elicitation Promise
// ---------------------------------------------------------------------------

/**
 * Handle a text/number/multi_choice elicitation.
 *
 * Returns a Promise that resolves when the user replies (or aborts).
 * All state is passed explicitly; no closures over factory-level locals.
 */
export function handleTextElicitation(
  ctx: ElicitationCtx,
  qType: string,
  displayText: string,
): Promise<import('../agent/types/sdk-types.js').ElicitationResult> {
  return new Promise((resolve) => {
    const guard: ResolveGuard = { resolved: false };
    // isFirstPrompt: :cancel hint shown only on the initial prompt to avoid cluttering re-prompts.
    let isFirstPrompt = true;

    const onAbort = () => {
      if (guard.resolved) return;
      guard.resolved = true;
      // M6: log abandoned-entry cleanup so diagnostic traces surface if the
      // re-prompt race (H1) or an unanticipated path leaves a stale entry.
      if (ctx.messageHandler.pendingElicitations.has(ctx.key)) {
        console.warn(palette.warning(`[elicitation-handler] abort: cleaning up stale pendingElicitation for route ${ctx.key}`),
        );
      }
      ctx.deletePending();
      resolve({ action: 'decline' });
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    function handleText(text: string): void {
      if (guard.resolved) return;
      guard.resolved = true;
      ctx.signal.removeEventListener('abort', onAbort);

      const trimmed = text.trim();
      if (trimmed === ':cancel') { resolve({ action: 'cancel' }); return; }
      if (trimmed === '' && ctx.request.allowSkip) { resolve({ action: 'skip' }); return; }

      isFirstPrompt = false;

      if (qType === 'number') {
        handleNumberReply(trimmed, ctx, guard, resolve, onAbort, handleText);
      } else if (qType === 'multi_choice') {
        handleMultiChoiceReply(trimmed, ctx, guard, resolve, onAbort, handleText);
      } else {
        handlePlainTextReply(trimmed, ctx, guard, resolve, onAbort, handleText);
      }
    }

    // Register intercept first, then send the prompt.
    ctx.setPending(handleText);

    const promptText = buildTextPrompt(displayText, ctx.request, qType, isFirstPrompt);

    // Fix (issue #3631, item 3): if promptText exceeds TELEGRAM_MAX_CHARS, split
    // it into chunks. Send all but the last as plain pre-messages, then send the
    // last chunk as the interceptable prompt (the one the user replies to).
    const chunks = splitLongPrompt(promptText);
    const preChunks = chunks.slice(0, -1);
    const finalChunk = chunks[chunks.length - 1]!;

    const sendFinal = () => {
      if (guard.resolved) return;
      ctx.bot.telegram
        .sendMessage(ctx.chatId, finalChunk, { parse_mode: 'HTML', ...ctx.threadOpts })
        .catch(() => {
          if (!guard.resolved) {
            guard.resolved = true;
            ctx.signal.removeEventListener('abort', onAbort);
            // M6: log sendMessage failure so callers can diagnose silent declines
            // without a visible error (e.g., MarkdownV2 parse failure, network error).
            console.warn(palette.warning(`[elicitation-handler] sendMessage failed; declining elicitation for route ${ctx.key}`),
            );
            ctx.deletePending();
            resolve({ action: 'decline' });
          }
        });
    };

    if (preChunks.length === 0) {
      sendFinal();
    } else {
      const sendPre = async () => {
        for (const chunk of preChunks) {
          if (guard.resolved) return;
          await ctx.bot.telegram.sendMessage(ctx.chatId, chunk, {
            parse_mode: 'HTML',
            ...ctx.threadOpts,
          });
        }
      };
      sendPre().then(sendFinal).catch((err: unknown) => {
        if (!guard.resolved) {
          guard.resolved = true;
          ctx.signal.removeEventListener('abort', onAbort);
          console.warn(palette.warning(`[elicitation-handler] pre-message sendMessage failed; declining elicitation for route ${ctx.key}: ${err instanceof Error ? err.message : String(err)}`),
          );
          ctx.deletePending();
          resolve({ action: 'decline' });
        }
      });
    }
  });
}
