/**
 * Telegram-side next-turn injection for background subagent results.
 *
 * Two concerns, both kept out of `handlers/message.ts` (over its size baseline):
 *
 *   1. **Per-route notifier registry** — each Telegram session's
 *      `TelegramBgResultNotifier` registers itself here under its canonical
 *      `routeKey` on construction and unregisters on `dispose()`.
 *      `MessageHandler.processOne` calls {@link drainBgInjections} with the
 *      incoming turn's route key, so results only ever reach the chat/topic
 *      whose session dispatched the job. A module-level map (rather than a
 *      handle threaded through bot → session factory → wiring) keeps the
 *      plumbing to one call on each side; one bot process owns one map.
 *
 *   2. **Content prepending** — {@link prependToContent} inserts the drained
 *      envelopes ahead of the turn's content (string or content-block array),
 *      mirroring the REPL loop's drain-then-prepend contract.
 *
 * @module telegram/bg-injection
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

/** Minimal notifier surface the registry needs (avoids an import cycle). */
export interface BgInjectionSource {
  drainInjections(): string;
}

const sources = new Map<string, BgInjectionSource>();

/** Register (or replace) the injection source for a route key. */
export function registerBgInjectionSource(key: string, source: BgInjectionSource): void {
  if (sources.has(key)) {
    // A pre-existing entry for this route key means a prior session disposed
    // without calling unregisterBgInjectionSource (e.g. it crashed). The new
    // registration is safe — overwrite-on-collision prevents cross-session
    // contamination — but we log so operators can spot persistent leaks.
    console.warn(`[bg-injection] replacing stale source for route '${key}' — prior session may have exited without dispose()`);
  }
  sources.set(key, source);
}

/**
 * Unregister a route's source — only when it is still the registered one, so
 * a disposed old session can't evict the fresh session that replaced it.
 */
export function unregisterBgInjectionSource(key: string, source: BgInjectionSource): void {
  if (sources.get(key) === source) sources.delete(key);
}

/** Drain pending injections for a route; empty string when none. */
export function drainBgInjections(key: string): string {
  return sources.get(key)?.drainInjections() ?? '';
}

/**
 * Prepend `prefix` to a turn's content. Strings concatenate; content-block
 * arrays get a leading `text` block so image/document blocks stay intact.
 * Returns `content` unchanged when `prefix` is empty.
 */
export function prependToContent(
  prefix: string,
  content: string | ContentBlockParam[],
): string | ContentBlockParam[] {
  if (!prefix) return content;
  if (typeof content === 'string') return prefix + content;
  return [{ type: 'text' as const, text: prefix }, ...content];
}
