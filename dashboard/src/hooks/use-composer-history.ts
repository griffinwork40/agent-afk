/**
 * Per-session prompt history with up-arrow recall.
 *
 * Invariant: history is session-scoped and stored in a module-level Map so it
 * survives re-renders without localStorage persistence (which would collide
 * across tabs on the same session). localStorage persistence is handled by
 * useComposerDraft; this hook is for the in-memory undo ring only.
 *
 * Keyboard contract:
 *   - Up-arrow navigates backward through history ONLY when the textarea caret
 *     is on the first line (position <= first newline index, or no newline).
 *     This matches terminal / Slack behaviour: mid-text navigation is not
 *     hijacked.
 *   - Down-arrow navigates forward; at the live end the original draft is
 *     restored.
 *   - History entries are deduplicated: submitting the same text twice in a row
 *     stores only one entry.
 */

import { useCallback, useRef } from 'react';

/** Maximum entries kept per session. */
const MAX_HISTORY = 100;

/** Module-level store: sessionId → ordered list (oldest-first). */
const store = new Map<string, string[]>();

function getHistory(sessionId: string): string[] {
  let h = store.get(sessionId);
  if (!h) { h = []; store.set(sessionId, h); }
  return h;
}

export interface UseComposerHistoryResult {
  /** Call after a successful prompt submit to record the text. */
  push: (text: string) => void;
  /**
   * Handle an up/down arrow keydown inside the textarea.
   * Returns the new text to set, or null if the key was not consumed.
   *
   * @param key       'ArrowUp' | 'ArrowDown'
   * @param current   current textarea value
   * @param selStart  textarea.selectionStart
   */
  navigate: (key: 'ArrowUp' | 'ArrowDown', current: string, selStart: number) => string | null;
}

export function useComposerHistory(sessionId: string): UseComposerHistoryResult {
  /** Index into history: -1 means "live" (not browsing history). */
  const cursorRef = useRef(-1);
  /** Draft saved before the first up-arrow so down-arrow restores it. */
  const savedDraftRef = useRef('');

  // Reset cursor when session changes.
  const lastSessionRef = useRef(sessionId);
  if (lastSessionRef.current !== sessionId) {
    lastSessionRef.current = sessionId;
    cursorRef.current = -1;
    savedDraftRef.current = '';
  }

  const push = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const h = getHistory(sessionId);
    // Deduplicate consecutive identical entries.
    if (h.length > 0 && h[h.length - 1] === trimmed) return;
    h.push(trimmed);
    if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
    // Reset cursor so the next up-arrow starts from the newest entry.
    cursorRef.current = -1;
  }, [sessionId]);

  const navigate = useCallback((
    key: 'ArrowUp' | 'ArrowDown',
    current: string,
    selStart: number,
  ): string | null => {
    // Only intercept up-arrow when caret is on the first line.
    if (key === 'ArrowUp') {
      const firstNewline = current.indexOf('\n');
      const onFirstLine = firstNewline === -1 || selStart <= firstNewline;
      if (!onFirstLine) return null;
    }

    const h = getHistory(sessionId);
    if (h.length === 0) return null;

    if (key === 'ArrowUp') {
      if (cursorRef.current === -1) {
        // Save current draft before browsing.
        savedDraftRef.current = current;
        cursorRef.current = h.length - 1;
      } else if (cursorRef.current > 0) {
        cursorRef.current -= 1;
      } else {
        // Already at oldest — no change.
        return h[0] ?? null;
      }
      return h[cursorRef.current] ?? null;
    }

    // ArrowDown
    if (cursorRef.current === -1) return null; // not browsing
    if (cursorRef.current < h.length - 1) {
      cursorRef.current += 1;
      return h[cursorRef.current] ?? null;
    }
    // At newest — restore draft.
    cursorRef.current = -1;
    return savedDraftRef.current;
  }, [sessionId]);

  return { push, navigate };
}
