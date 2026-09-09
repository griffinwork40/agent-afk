/**
 * Scroll-to-bottom pinning hook.
 *
 * Attaches to a scrollable container ref. When the user is scrolled within
 * PINNED_THRESHOLD_PX of the bottom, new content triggers an automatic scroll.
 * When the user has scrolled up, auto-scroll is suppressed until they return
 * to the bottom.
 *
 * Contract: attach `containerRef` to the element that has `overflow-y: auto`
 * (or `scroll`). Call `scrollToBottom()` whenever new items are added — the
 * hook decides whether to act based on the current pin state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const PINNED_THRESHOLD_PX = 50;

export interface UseScrollPinResult {
  /** Attach this to the scrollable container element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Scroll to the bottom of the container. */
  scrollToBottom: () => void;
  /** Whether the container is currently pinned to the bottom. */
  isPinned: boolean;
}

export function useScrollPin(): UseScrollPinResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(true);

  // Track pin state on scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    function handleScroll(): void {
      if (el === null) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setIsPinned(distanceFromBottom <= PINNED_THRESHOLD_PX);
    }

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return;
    if (!isPinned) return;
    el.scrollTop = el.scrollHeight;
  }, [isPinned]);

  return { containerRef, scrollToBottom, isPinned };
}
