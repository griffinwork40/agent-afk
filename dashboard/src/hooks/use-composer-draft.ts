/**
 * Per-session draft persistence in localStorage.
 *
 * Contract: drafts are keyed by `afk:draft:<sessionId>` so switching sessions
 * or reloading the page restores the half-typed text for the correct session.
 * A draft is cleared when the composer text is empty or after a successful
 * submit (call `clear()` then).
 *
 * Invariant: localStorage access is wrapped in try/catch throughout because
 * the API can throw in private-browsing mode or when storage is full. Failures
 * are silent — draft loss is better than a crash.
 */

import { useCallback, useEffect } from 'react';

const PREFIX = 'afk:draft:';

function draftKey(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export interface UseComposerDraftResult {
  /** Load the saved draft for the current session (empty string if none). */
  load: () => string;
  /** Persist the current draft text. Pass empty string to clear. */
  save: (text: string) => void;
  /** Remove the draft (called after successful submit). */
  clear: () => void;
}

export function useComposerDraft(sessionId: string): UseComposerDraftResult {
  const load = useCallback((): string => {
    try {
      return localStorage.getItem(draftKey(sessionId)) ?? '';
    } catch {
      return '';
    }
  }, [sessionId]);

  const save = useCallback((text: string): void => {
    try {
      if (text) {
        localStorage.setItem(draftKey(sessionId), text);
      } else {
        localStorage.removeItem(draftKey(sessionId));
      }
    } catch {
      // Ignore storage errors.
    }
  }, [sessionId]);

  const clear = useCallback((): void => {
    try {
      localStorage.removeItem(draftKey(sessionId));
    } catch {
      // Ignore storage errors.
    }
  }, [sessionId]);

  // Auto-clear stale drafts older than 7 days to avoid unbounded growth.
  // We store the timestamp alongside the draft as a separate key.
  useEffect(() => {
    try {
      const tsKey = `${draftKey(sessionId)}:ts`;
      const saved = localStorage.getItem(tsKey);
      if (saved) {
        const age = Date.now() - Number(saved);
        if (age > 7 * 24 * 60 * 60 * 1000) {
          localStorage.removeItem(draftKey(sessionId));
          localStorage.removeItem(tsKey);
        }
      } else {
        // Stamp on first load.
        localStorage.setItem(tsKey, String(Date.now()));
      }
    } catch {
      // Ignore.
    }
  }, [sessionId]);

  return { load, save, clear };
}
