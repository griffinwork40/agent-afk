/**
 * Route-resolution helper for the auto-subscribe watch loop.
 *
 * Extracted from SessionManager to keep session-manager.ts within the 350-line
 * code ceiling. This module owns ONE concern: given an iterable of SessionData
 * entries, find the most recently active route for a specific chatId.
 *
 * @module telegram/session-manager.active-route
 */

import type { SessionData } from './session-manager.js';
import type { TelegramRoute } from './route.js';

/**
 * Return the most recently active route for a given chatId, or `undefined`
 * when no session data exists for that chat.
 *
 * Used by the auto-subscribe watch loop to pin outbound watch messages to the
 * topic the operator last interacted with instead of always routing to General.
 * When a chat has sessions on multiple topics the one with the latest
 * `lastActivity` timestamp wins; ties break arbitrarily. Returns `undefined`
 * (not `{ chatId }`) when no data exists so callers can distinguish "no session
 * ever seen" from "General topic session exists".
 *
 * Non-topic chats (threadId absent) naturally produce `{ chatId }`, which
 * sendOptions treats as General — byte-identical to the pre-fix behavior.
 */
export function resolveActiveRouteForChat(
  data: Iterable<SessionData>,
  chatId: number,
): TelegramRoute | undefined {
  let best: SessionData | undefined;
  for (const entry of data) {
    if (entry.chatId !== chatId) continue;
    if (!best || entry.lastActivity > best.lastActivity) best = entry;
  }
  if (!best) return undefined;
  const route: TelegramRoute = { chatId: best.chatId };
  if (best.threadId !== undefined) route.threadId = best.threadId;
  return route;
}
