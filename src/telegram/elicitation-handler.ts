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
 * Per-type handler modules:
 *   - elicitation-handler.choice.ts  — confirm/choice inline-keyboard path
 *   - elicitation-handler.text.ts    — text/number/multi_choice reply path
 *   - elicitation-handler.render.ts  — prepareChoiceRender helper
 *   - elicitation-handler.types.ts   — shared types and constants
 *
 * @module telegram/elicitation-handler
 */

import { Telegraf } from 'telegraf';
import type { ElicitationHandler } from '../agent/elicitation-router.js';
import type { ElicitationRequest, ElicitationResult } from '../agent/types/sdk-types.js';
import type { MessageHandler } from './handlers/message.js';
import { type TelegramRoute, routeKey, sendOptions } from './route.js';
import { getElicitationRoute } from './elicitation-route-registry.js';
import {
  parseElicitationCallback,
  ELICITATION_CALLBACK_PREFIX,
  parseCustomElicitationCallback,
  ELICITATION_CUSTOM_CALLBACK_PREFIX,
} from './elicitation-callback-data.js';
import { randomBytes } from 'node:crypto';
import { escapeHtml } from './formatter.js';
import { escapeRegExp } from '../utils/regexp.js';
import { CUSTOM_ENTRY_SENTINEL_INDEX } from './elicitation-handler.types.js';
import type { ChoiceResolver } from './elicitation-handler.choice.js';
import { handleChoiceElicitation } from './elicitation-handler.choice.js';
import { handleTextElicitation } from './elicitation-handler.text.js';

function nextElicitationId(): string {
  return `elic-${randomBytes(8).toString('hex')}`;
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
 * @param target - The fallback route to send questions to when no session-specific
 *   route is available. Accepts a bare chatId (General topic), a TelegramRoute,
 *   or a resolver for watches whose active topic can change while they run.
 *   When a `sessionId` is provided in the handler's options, the elicitation-route
 *   registry is consulted first and the fallback is only used if no mapping exists.
 * @param opts.ledgerOriginated - When true, every text-intercept entry also
 *   registers the route in `messageHandler.ledgerOriginatedPendingChats` so
 *   the message handler's idle-guard fires the resolver even with no active
 *   AgentSession for this route (the REPL session runs in a separate process).
 */
export function makeTelegramElicitationHandler(
  messageHandler: MessageHandler,
  bot: Telegraf,
  target: TelegramRoute | number | (() => TelegramRoute),
  opts?: { ledgerOriginated?: boolean },
): ElicitationHandler {
  // Fallback route: used when no session-specific mapping exists in the registry.
  // A bare chatId is that chat's General topic.
  const fallbackRoute = (): TelegramRoute => {
    if (typeof target === 'function') return target();
    return typeof target === 'number' ? { chatId: target } : target;
  };

  // Contract: ledgerOriginated elicitations bypass the session-state guard in
  // MessageHandler.handle() — the resolver fires on the next text reply
  // regardless of whether an AgentSession exists for this route.
  const ledgerOriginated = opts?.ledgerOriginated ?? false;

  /**
   * H3: Single dispatch table for confirm/choice elicitations.
   * Keys are cryptographically random elicitation IDs. Values retain both the
   * destination chat and resolver so callback queries can be authenticated
   * against the chat that received that particular keyboard.
   * Entries are deleted synchronously on resolve or abort.
   */
  const pendingChoiceElicitations = new Map<string, ChoiceResolver>();

  /**
   * H3: One wildcard action handler registered once.
   * All confirm/choice button presses route through here.
   * Defence-in-depth: only accepts callbacks from the bot's allowed chat IDs
   * (checked by the allowlist middleware upstream; we additionally guard
   * that the callback comes from ANY known chat managed by this bot by
   * accepting when chat.id matches ANY registered route's chatId — the
   * elicitation dispatch table itself is the true gating mechanism, since
   * each resolver is keyed by the full elicitId which is only sent to the
   * correct chat in the first place).
   */
  const wildcardRe = new RegExp(`^${escapeRegExp(ELICITATION_CALLBACK_PREFIX)}\\d+:.+$`);
  bot.action(wildcardRe, async (ctx) => {
    // Answer the callback query FIRST to clear Telegram's spinner.
    await ctx.answerCbQuery().catch(() => {});
    const callbackData =
      typeof ctx.callbackQuery === 'object' && 'data' in ctx.callbackQuery
        ? (ctx.callbackQuery as { data: string }).data
        : undefined;
    const parsed = parseElicitationCallback(callbackData);
    if (!parsed) return;

    // The dispatch table is keyed by bare elicitId (the resolver lookup does
    // not need the routeKey prefix — elicitIds are cryptographically random
    // and globally unique within the process).
    const pending = pendingChoiceElicitations.get(parsed.id);
    if (pending && ctx.chat?.id === pending.chatId) pending.resolve(parsed.choiceIndex);
  });

  const customWildcardRe = new RegExp(`^${escapeRegExp(ELICITATION_CUSTOM_CALLBACK_PREFIX)}.+$`);
  bot.action(customWildcardRe, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const callbackData =
      typeof ctx.callbackQuery === 'object' && 'data' in ctx.callbackQuery
        ? (ctx.callbackQuery as { data: string }).data
        : undefined;
    const id = parseCustomElicitationCallback(callbackData);
    if (!id) return;
    const pending = pendingChoiceElicitations.get(id);
    if (pending && ctx.chat?.id === pending.chatId) pending.resolve(CUSTOM_ENTRY_SENTINEL_INDEX);
  });

  return async (
    request: ElicitationRequest,
    options: { signal: AbortSignal; sessionId?: string },
  ): Promise<ElicitationResult> => {
    if (options.signal.aborted) return { action: 'decline' };

    // Resolve route per-elicitation: if a sessionId is provided, look it up in
    // the route registry (set by SessionManager when the session's SDK id becomes
    // known). Fall back to the factory's route (General topic of the primary
    // chatId by default) when no mapping exists — preserves pre-topics behaviour.
    const resolvedRoute: TelegramRoute =
      (options.sessionId !== undefined ? getElicitationRoute(options.sessionId) : undefined)
      ?? fallbackRoute();
    const chatId = resolvedRoute.chatId;
    const key = routeKey(resolvedRoute);
    const threadOpts = sendOptions(resolvedRoute);

    // Helpers that keep pendingElicitations and ledgerOriginatedPendingChats in
    // sync, scoped to the resolved route for this specific elicitation.
    // All text-intercept registrations and deletions must use these instead
    // of touching the maps directly, so the bypass set never drifts from reality.
    function setPending(resolver: (text: string) => void): void {
      messageHandler.pendingElicitations.set(key, resolver);
      if (ledgerOriginated) messageHandler.ledgerOriginatedPendingChats.add(key);
    }
    function deletePending(): void {
      messageHandler.pendingElicitations.delete(key);
      if (ledgerOriginated) messageHandler.ledgerOriginatedPendingChats.delete(key);
    }

    const qType = request.type ?? 'text';
    const questionText = request.message;

    // Build display text
    let displayText = `💬 <b>Question from agent</b>\n\n${escapeHtml(questionText)}`;
    if (request.context) {
      displayText = `💬 <b>Question from agent</b>\n\n<i>${escapeHtml(request.context)}</i>\n\n${escapeHtml(questionText)}`;
    }

    if (qType === 'confirm' || qType === 'choice') {
      return handleChoiceElicitation(
        {
          chatId,
          threadOpts,
          request,
          signal: options.signal,
          bot,
          elicitId: nextElicitationId(),
          pendingChoiceElicitations,
          setPending,
          deletePending,
        },
        qType,
        displayText,
      );
    }

    // text / number / multi_choice — plain message + intercept next reply
    return handleTextElicitation(
      {
        chatId,
        threadOpts,
        request,
        signal: options.signal,
        bot,
        setPending,
        deletePending,
        key,
        messageHandler,
      },
      qType,
      displayText,
    );
  };
}
