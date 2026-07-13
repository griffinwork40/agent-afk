/**
 * Telegram routing primitive — the ingress side of the session registry.
 *
 * A `TelegramRoute` identifies WHICH conversation an update belongs to inside a
 * single bot DM: the chat plus, when Telegram "topics in private chats" is in
 * play, the topic's `message_thread_id`. `routeKey()` turns a route into the
 * opaque string the session registry binds on (`resolve('telegram', key)`).
 *
 * Invariant: the General topic (`message_thread_id` absent OR === 1) normalizes
 * to the bare-chatId key, so a chat with topics disabled — and every existing
 * single-session user — maps to the SAME key the pre-registry bot used and the
 * Step-2 legacy migration synthesizes (`String(chatId)`). Topics are additive.
 *
 * Leak fix (see session-registry-architecture.md §11): the thread id is read
 * from whichever update part carries it — a normal `message`, an
 * `edited_message`, OR a `callback_query`'s attached message (a button tapped
 * inside a topic carries its thread id on `callbackQuery.message`, NOT on
 * `ctx.message`). Reading only `ctx.message` would misroute button taps to
 * General. Extraction is defensive (no reliance on Telegraf's evolving Message
 * typing) and never throws.
 *
 * @module telegram/route
 */

import type { Context } from 'telegraf';

/** The General/root topic id. Messages here (or with no thread) share the chat's default session. */
export const GENERAL_TOPIC_ID = 1;

/** Which conversation an update belongs to within one bot chat. */
export interface TelegramRoute {
  /** Telegram chat id (in a private DM this equals the user's account id). */
  chatId: number;
  /** Topic thread id when in a non-General topic; absent for General / topics-off. */
  threadId?: number;
  /** True when Telegram flagged the source as a topic message. */
  isTopicMessage?: boolean;
}

interface ExtractedThread {
  threadId?: number;
  isTopic?: boolean;
}

/** Defensively read message_thread_id / is_topic_message off any update part. */
function readThread(source: unknown): ExtractedThread {
  if (source === null || typeof source !== 'object') return {};
  const rec = source as Record<string, unknown>;
  const tid = rec['message_thread_id'];
  const isTopic = rec['is_topic_message'];
  return {
    ...(typeof tid === 'number' ? { threadId: tid } : {}),
    ...(isTopic === true ? { isTopic: true } : {}),
  };
}

/**
 * Derive the route for an incoming update, or `undefined` when it carries no
 * chat (nothing to route). The thread id is sourced from `message`,
 * `edited_message`, or `callback_query.message` — whichever is present.
 */
export function routeFromCtx(ctx: Context): TelegramRoute | undefined {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== 'number') return undefined;

  const source = ctx.message ?? ctx.editedMessage ?? ctx.callbackQuery?.message;
  const { threadId, isTopic } = readThread(source);

  const route: TelegramRoute = { chatId };
  if (threadId !== undefined) route.threadId = threadId;
  if (isTopic) route.isTopicMessage = true;
  return route;
}

/** True when the route addresses the General topic (or topics are off). */
export function isGeneral(route: TelegramRoute): boolean {
  return route.threadId === undefined || route.threadId === GENERAL_TOPIC_ID;
}

/**
 * The opaque registry binding key for a route. General normalizes to the bare
 * chat id (back-compat with the pre-registry key + the Step-2 legacy binding);
 * a real topic keys as `${chatId}:${threadId}`.
 */
export function routeKey(route: TelegramRoute): string {
  return isGeneral(route) ? String(route.chatId) : `${route.chatId}:${route.threadId}`;
}

/**
 * Telegram send options that pin a reply to the route's topic. General/absent
 * omits `message_thread_id` (Telegram delivers to General by default), so
 * existing non-topic sends are byte-identical.
 */
export function sendOptions(route: TelegramRoute): { message_thread_id?: number } {
  return isGeneral(route) ? {} : { message_thread_id: route.threadId };
}
