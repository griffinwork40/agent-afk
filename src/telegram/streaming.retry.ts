/**
 * Telegram flood-control retry utilities
 *
 * `floodRetryAfterMs` and `replyWithFloodRetry` extracted from streaming.ts —
 * the public surface of streaming.ts is unchanged (both are re-exported there).
 * @module telegram/streaming.retry
 */

import { TelegramError } from 'telegraf';

/** Max flood-control (429) retries per outbound message before giving up. */
export const MAX_FLOOD_RETRIES = 2;
/** Upper bound on how long we honor a single Telegram `retry_after`. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Fallback backoff when a 429 carries no `retry_after`. */
export const DEFAULT_FLOOD_BACKOFF_MS = 1_000;

/** Real wall-clock sleep; injectable in tests via `replyWithFloodRetry` opts. */
export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Telegram flood-control (429) retry-after in ms, or `null` when `e` is not a
 * 429. Prefers the structured `parameters.retry_after`, falls back to parsing
 * the "retry after N" description, then to a small default — always capped.
 */
export function floodRetryAfterMs(e: unknown): number | null {
  if (!(e instanceof TelegramError) || e.code !== 429) return null;
  const fromParams = e.parameters?.retry_after;
  const fromText = Number(/retry after (\d+)/i.exec(e.description ?? '')?.[1]);
  const secs =
    typeof fromParams === 'number' && fromParams > 0
      ? fromParams
      : Number.isFinite(fromText) && fromText > 0
        ? fromText
        : 0;
  return Math.min(secs > 0 ? secs * 1_000 : DEFAULT_FLOOD_BACKOFF_MS, MAX_RETRY_AFTER_MS);
}

/**
 * Send one message via `reply`, retrying on Telegram flood-control (429) up to
 * `maxRetries` times and honoring the server's `retry_after`. A long reply fans
 * out into several back-to-back sends; without this a single 429 aborted the
 * whole delivery and the tail was dropped silently. Non-429 errors (including the
 * 400 "can't parse entities" the caller handles specially) propagate immediately.
 * Exported for unit tests; `sleep` is injectable so tests never wait real seconds.
 */
export async function replyWithFloodRetry(
  reply: (text: string, extra?: { parse_mode?: 'HTML' }) => Promise<unknown>,
  text: string,
  extra?: { parse_mode?: 'HTML' },
  opts: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const maxRetries = opts.maxRetries ?? MAX_FLOOD_RETRIES;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      await reply(text, extra);
      return;
    } catch (e) {
      const waitMs = floodRetryAfterMs(e);
      if (waitMs === null || attempt >= maxRetries) throw e;
      await sleep(waitMs);
    }
  }
}
