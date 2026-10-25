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
 *
 * Invariant: `showScrollButton` is true whenever the user is scrolled far
 * enough up (best-in-class: always show ↓ so the user can get back). The
 * `hasNewContent` flag is layered on top: the label expands to "New messages"
 * only when content arrived while the user was scrolled up. Scrolling to the
 * bottom clears both flags and hides the pill.
 *
 * History: D4 set showScrollButton = hasNewContent && scrolledUp, which hid
 * the button when the user scrolled up through a FINISHED answer with no new
 * content arriving — no way back to the bottom without manual scroll. Fix:
 * expose `isScrolledUp` separately; the pill is always visible when scrolled
 * up, and the label "New messages" is added only when hasNewContent is true.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const PINNED_THRESHOLD_PX = 50;

/** Distance from bottom beyond which the jump button appears. */
const SHOW_BUTTON_THRESHOLD_PX = 200;

export interface UseScrollPinResult {
  /** Attach this to the scrollable container element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Scroll to the bottom of the container. Always works, regardless of pin state. */
  scrollToBottom: () => void;
  /** Whether the container is currently pinned to the bottom. */
  isPinned: boolean;
  /**
   * True whenever the user is scrolled far enough up (≥ SHOW_BUTTON_THRESHOLD_PX
   * from the bottom). The jump button is visible whenever this is true.
   */
  showScrollButton: boolean;
  /**
   * True when the user is scrolled up AND new content has arrived since they
   * left the bottom. Cleared when the user scrolls back to the bottom.
   * Use to expand the button label to "New messages".
   */
  hasNewContent: boolean;
  /**
   * Call whenever new content is appended. If the user is currently scrolled
   * up, this arms the "New messages" label.
   */
  notifyNewContent: () => void;
}

export function useScrollPin(): UseScrollPinResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  // True when the user is far enough from the bottom.
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  // True only when new content arrived while the user was scrolled up.
  const [hasNewContent, setHasNewContent] = useState(false);
  // Ref mirror of isScrolledUp for use inside notifyNewContent callback.
  const scrolledUpRef = useRef(false);
  // Ref mirror of isPinned, read synchronously inside the scroll handler.
  const pinnedRef = useRef(true);
  // Ref shared between the scroll handler closure and scrollToBottom, so a
  // programmatic scroll updates lastTop and the handler does not misclassify
  // the next event as a user scroll-up (stale closure over the old value).
  const lastTopRef = useRef(0);

  // Track pin state and button visibility on scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    // Invariant: only a USER scroll (scrollTop moving up) may release the pin.
    // A scroll event caused by layout (viewport resize, the pill's padding
    // toggle, content reflow) is not intent: while pinned it re-pins to the
    // bottom instead of unpinning. History: a phone-width resize mid-turn plus
    // the pill's conditional bottom padding unpinned the transcript, so the
    // next turn's live draft rendered below the fold (content-visibility:auto
    // skipped it) and the screen stayed blank while busy.
    // A user scroll-up always lowers scrollTop; a reflow that grows the
    // content (narrower viewport, padding added) leaves scrollTop unchanged.
    lastTopRef.current = el.scrollTop;
    let lastTop = lastTopRef.current;
    let lastHeight = el.scrollHeight;
    function handleScroll(): void {
      if (el === null) return;
      // Content removal (Retry/edit/rewind drops items) shrinks scrollHeight and the
      // browser clamps scrollTop down with it: that is layout, not a user scroll-up.
      const shrank = el.scrollHeight < lastHeight;
      lastHeight = el.scrollHeight;
      const userScrolledUp = el.scrollTop < lastTop && !shrank;
      lastTop = el.scrollTop;
      lastTopRef.current = lastTop;
      if (pinnedRef.current && !userScrolledUp
        && el.scrollHeight - el.scrollTop - el.clientHeight > PINNED_THRESHOLD_PX) {
        el.scrollTop = el.scrollHeight;
        lastTop = el.scrollTop;
        lastTopRef.current = lastTop;
      }
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const pinned = distanceFromBottom <= PINNED_THRESHOLD_PX;
      pinnedRef.current = pinned;
      const scrolledUp = distanceFromBottom > SHOW_BUTTON_THRESHOLD_PX;
      scrolledUpRef.current = scrolledUp;
      setIsPinned(pinned);
      setIsScrolledUp(scrolledUp);
      // Clear the new-content flag when user returns near the bottom.
      if (pinned) setHasNewContent(false);
    }

    // Invariant: while pinned, ANY growth of the content re-pins to the bottom,
    // not only growth that a React effect knows about. Effects key on data
    // (items, session id), but layout can change with no data change. After a
    // reload with ?session=, the transcript items can arrive before the session
    // list; the items effect scrolls while nothing is rendered (height = the
    // viewport), then the list resolves, the transcript renders 4000px tall, and
    // no dependency changes, so the page sat at scrollTop 0 forever.
    // A layout-driven size change emits no scroll event, so only an observer sees it.
    const content = el.firstElementChild;
    const ro = typeof ResizeObserver === 'undefined' || content === null ? null : new ResizeObserver(() => {
      if (pinnedRef.current && el.scrollHeight - el.scrollTop - el.clientHeight > PINNED_THRESHOLD_PX) {
        el.scrollTop = el.scrollHeight;
        lastTop = el.scrollTop;
        lastTopRef.current = lastTop;
      }
    });
    if (ro !== null && content !== null) ro.observe(content);

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => { ro?.disconnect(); el.removeEventListener('scroll', handleScroll); };
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
    pinnedRef.current = true;
    setHasNewContent(false);
  }, []);

  const notifyNewContent = useCallback(() => {
    // Only arm the "New messages" label if the user is actually scrolled up.
    if (scrolledUpRef.current) setHasNewContent(true);
  }, []);

  return { containerRef, scrollToBottom, isPinned, showScrollButton: isScrolledUp, hasNewContent, notifyNewContent };
}
