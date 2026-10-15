/**
 * Shared lifecycle helpers for image tool handlers (image_generate, image_edit).
 *
 * Provides:
 *   - `makeSessionCounter()` — per-operation, per-session quota lease.
 *     Each tool (generate / edit) gets its own counter instance so an edit
 *     does not consume a generate slot and vice versa, while both are bounded
 *     by the same AFK_IMAGE_SESSION_LIMIT env var.
 *
 * @module agent/tools/handlers/_image-operation
 */

// ---------------------------------------------------------------------------
// Session counter factory
// ---------------------------------------------------------------------------

export interface SessionCounter {
  /** Current count for `sessionId`, or 0 if unseen. */
  get(sessionId: string): number;
  /** Increment and return the new count. */
  increment(sessionId: string): number;
  /** Decrement (floor 0). Used to undo optimistic increments on failure paths. */
  decrement(sessionId: string): void;
}

/**
 * Create an isolated per-session operation counter.
 *
 * Callers (image_generate, image_edit) each get their own instance so quotas
 * are tracked separately — an image edit does not burn a generation slot.
 */
export function makeSessionCounter(): SessionCounter {
  const map = new Map<string, number>();

  return {
    get(sessionId: string): number {
      return map.get(sessionId) ?? 0;
    },
    increment(sessionId: string): number {
      const next = (map.get(sessionId) ?? 0) + 1;
      map.set(sessionId, next);
      return next;
    },
    decrement(sessionId: string): void {
      const current = map.get(sessionId) ?? 0;
      if (current > 0) map.set(sessionId, current - 1);
    },
  };
}
