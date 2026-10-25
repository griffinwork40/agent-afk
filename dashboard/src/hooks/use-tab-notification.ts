/**
 * Tab title badge + Web Notification when a turn finishes while the tab is hidden.
 *
 * Invariant: notification permission is NEVER requested by this hook. The
 * caller must request permission in response to a direct user gesture (e.g.
 * a "Enable notifications" button click) before notifications will fire.
 * Silent permission-check is fine; silent permission-request is not.
 *
 * Contract: wire once per session view. When `liveTurns` increments and
 * `document.hidden` is true, the document title gains a "(✓) " prefix and —
 * if Notification.permission === 'granted' — a push notification is sent.
 * The badge is cleared on window focus.
 *
 * Cross-lane note: this hook adds a `useEffect` that mutates `document.title`.
 * The caller in app.tsx (layout lane) gets a one-line wire. The hook keeps
 * the original title in a ref so it can restore it cleanly.
 */

import { useEffect, useRef } from 'react';

const BADGE_PREFIX = '(✓) ';

export interface UseTabNotificationOptions {
  /** Increments when a live (non-replay) turn completes. */
  liveTurns: number;
  /** Used as the notification body text. */
  sessionTitle?: string;
  /** Whether the session is currently active/selected. */
  isSelected?: boolean;
}

export function useTabNotification({
  liveTurns,
  sessionTitle,
  isSelected,
}: UseTabNotificationOptions): void {
  const prevLiveTurnsRef = useRef(liveTurns);
  const hasBadgeRef = useRef(false);
  // Strip any stale badge prefix so a remount after unmount-with-badge doesn't
  // capture the already-badged title and leak the prefix permanently (B-4).
  const originalTitleRef = useRef(
    document.title.startsWith(BADGE_PREFIX)
      ? document.title.slice(BADGE_PREFIX.length)
      : document.title
  );

  // Clear badge on focus.
  useEffect(() => {
    function onFocus() {
      if (hasBadgeRef.current) {
        document.title = originalTitleRef.current;
        hasBadgeRef.current = false;
      }
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Badge + notify when a new live turn finishes while hidden.
  useEffect(() => {
    const prev = prevLiveTurnsRef.current;
    prevLiveTurnsRef.current = liveTurns;

    // Only act when liveTurns actually incremented (skip initial render).
    if (liveTurns <= prev) return;

    // Only notify when the tab is hidden (or the session is not the selected one).
    if (!document.hidden && isSelected !== false) return;

    // Update title badge.
    if (!hasBadgeRef.current) {
      originalTitleRef.current = document.title.startsWith(BADGE_PREFIX)
        ? document.title.slice(BADGE_PREFIX.length)
        : document.title;
    }
    document.title = BADGE_PREFIX + originalTitleRef.current;
    hasBadgeRef.current = true;

    // Push notification if permission was already granted.
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const n = new Notification('afk — turn complete', {
          body: sessionTitle ? `Session: ${sessionTitle}` : 'A turn finished.',
          tag: 'afk-turn-complete',
        });
        // Auto-close after 5 s to avoid notification pile-up.
        setTimeout(() => n.close(), 5000);
      } catch {
        // Notification API is available but failed (e.g. SW not registered). Ignore.
      }
    }
  }, [liveTurns, sessionTitle, isSelected]);
}
