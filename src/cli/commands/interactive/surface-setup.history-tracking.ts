import type { InputSurface } from '../../input/input-surface.js';

/**
 * Session-scoped submission tracker: records the most-recently submitted
 * entry that actually landed in the history ring. Used by the `lastSubmitted`
 * getter to return `undefined` at a fresh REPL start — before any
 * submission has occurred — rather than `entries[0]` from the previous
 * session's persisted ring. This prevents a false Tier-1 skip on the first
 * keystroke.
 *
 * Invariant: only set when push() actually modifies _entries. ReplHistory
 * has four early-return paths (leading-space, empty, secret-pattern,
 * consecutive-duplicate) that leave _entries unchanged — incrementing
 * blindly on those would cause lastSubmitted to return the wrong entry.
 */
export interface HistorySubmissionTracker {
  /** Most-recently submitted entry that actually landed in the ring, or
   *  `undefined` until a submission modifies _entries this session. */
  getLastSubmitted: () => string | undefined;
}

/**
 * Installs a monkey-patch on `surface.history.push` that tracks whether
 * each push actually mutated the history ring (by comparing the head
 * entry before and after). Returns a `getLastSubmitted` getter that is
 * O(1) — no `getEntries()` allocation per keystroke.
 *
 * When history, push, or getEntries is absent (test stubs, non-TTY
 * surfaces, partial history implementations), `getLastSubmitted` stays
 * `() => undefined` for the session lifetime — safe because ghost text
 * is disabled on those surfaces.
 */
export function installHistorySubmissionTracker(
  surface: InputSurface,
): HistorySubmissionTracker {
  let lastSubmittedEntry: string | undefined;

  // surface.history is undefined in test stubs and non-TTY surfaces that
  // never construct a ReplHistory. Guard before the cast so the typeof
  // check below doesn't throw on undefined property access.
  const historyRing = (surface.history as {
    getEntries?: () => readonly string[];
    push?: (text: string) => void;
  } | undefined);

  if (historyRing && typeof historyRing.push === 'function') {
    const originalPush = historyRing.push.bind(historyRing);
    historyRing.push = (text: string) => {
      const headBefore = historyRing.getEntries?.()?.[0];
      originalPush(text);
      const headAfter = historyRing.getEntries?.()?.[0];
      if (headAfter !== headBefore) {
        lastSubmittedEntry = headAfter;
      }
    };
  }

  return {
    getLastSubmitted: () => lastSubmittedEntry,
  };
}
