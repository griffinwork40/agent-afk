/**
 * LRU store mapping Telegram message IDs to agent session IDs.
 *
 * When the bot sends a reply it records `(chatId, messageId) → sessionId` here
 * so that a later `message_reaction` update can look up which session the
 * reacted-to message belongs to. Entries are evicted once the store reaches
 * MAX_SIZE to prevent unbounded memory growth.
 *
 * Keyed by `${chatId}:${messageId}` (both numbers) — unique across chats.
 * @module telegram/reaction-map
 */

/** Maximum number of mappings retained in memory. */
const MAX_SIZE = 500;

/** Composite key for a (chatId, messageId) pair. */
function makeKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Bounded LRU message-id → session-id map.
 *
 * Uses a plain `Map` which preserves insertion order; oldest-inserted entry is
 * evicted when the map reaches MAX_SIZE. One global instance is used throughout
 * the Telegram bot process.
 */
export class ReactionMap {
  private readonly map = new Map<string, string>();
  private readonly maxSize: number;

  constructor(maxSize: number = MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /**
   * Record that the bot sent `messageId` in `chatId` for `sessionId`.
   * Silently evicts the oldest entry when the cap is reached.
   */
  set(chatId: number, messageId: number, sessionId: string): void {
    const key = makeKey(chatId, messageId);
    if (this.map.has(key)) {
      // Refresh: delete then re-insert to move to the tail.
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict the oldest (first) entry.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, sessionId);
  }

  /**
   * Look up the session ID for a reacted-to message.
   * Returns `undefined` for unmapped or evicted messages.
   */
  get(chatId: number, messageId: number): string | undefined {
    return this.map.get(makeKey(chatId, messageId));
  }

  /** Number of entries currently held. Useful for tests. */
  get size(): number {
    return this.map.size;
  }

  /** Remove all entries. Useful for tests. */
  clear(): void {
    this.map.clear();
  }
}

/** Module-scope singleton — one map per bot process. */
export const reactionMap = new ReactionMap();
