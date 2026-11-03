/**
 * Operator notification port for the `agent/` layer.
 *
 * This module is the single import point for all `agent/` code that needs to
 * send out-of-band Telegram notifications. It exists to eliminate the
 * `agent/ → telegram/` layer violation that arises when `agent/` files import
 * `pushIfConfigured` directly from `telegram/push.ts`.
 *
 * The port re-exports a thin wrapper that forwards every call to the real
 * implementation. Keeping the wrapper in `agent/` means:
 *   - `agent/` code only depends on `agent/operator-notify.ts` (same layer).
 *   - Tests can swap the implementation by re-assigning `operatorNotify`
 *     without touching the `telegram/` package at all.
 *   - The full `PushOptions` option bag (replyMarkup, target, messageThreadId,
 *     markdown, …) and the `PushResult[] | null` return value are preserved,
 *     so callers that inspect delivery success are not broken.
 *
 * @module agent/operator-notify
 */

import type { PushResult } from '../telegram/push.js';
export type { PushResult } from '../telegram/push.js';

/**
 * Options accepted by `operatorNotify`. This is an exact structural match of
 * the second argument accepted by `pushIfConfigured` in `telegram/push.ts`,
 * so existing call-sites can be migrated without changing any option objects.
 */
export interface OperatorNotifyOptions {
  parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  markdown?: boolean;
  replyMarkup?: import('telegraf/types').InlineKeyboardMarkup;
  fetchImpl?: typeof fetch;
  /**
   * Explicit delivery target(s) that OVERRIDE the configured notify routing.
   * Forwarded verbatim to `pushIfConfigured`. Callers are responsible for
   * having already resolved aliases and enforced the allowlist (fail-closed).
   */
  target?: number | readonly number[];
  /**
   * Optional Telegram `message_thread_id` for sending to a specific topic
   * thread in a supergroup. Omit for non-topic chats.
   */
  messageThreadId?: number;
}

/**
 * Type of the notify function exposed by this port.
 *
 * Matches the full `pushIfConfigured` signature so callers that need to check
 * `PushResult[] | null` (startup-reconcile, oauth) are fully supported.
 */
export type OperatorNotifyFn = (
  text: string,
  opts?: OperatorNotifyOptions,
) => Promise<PushResult[] | null>;

/**
 * Send a notification to the configured Telegram operator chat(s).
 *
 * Drop-in replacement for `pushIfConfigured` inside the `agent/` layer.
 * Returns `null` when Telegram is not configured; returns `PushResult[]`
 * (possibly empty) otherwise.  Never throws — callers may still `.catch()`
 * for belt-and-suspenders safety, but errors from the underlying transport are
 * caught and returned as a failed `PushResult` entry.
 */
export const operatorNotify: OperatorNotifyFn = async (
  text: string,
  opts: OperatorNotifyOptions = {},
): Promise<PushResult[] | null> => {
  // Lazy import keeps the telegram package out of agent/ load paths that
  // don't end up calling this function (matches the pattern used in oauth.ts).
  const { pushIfConfigured } = await import('../telegram/push.js');
  return pushIfConfigured(text, opts);
};
