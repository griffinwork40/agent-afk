import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useScrollPin } from './use-scroll-pin';

/**
 * Build a real div with mocked read-only geometry properties.
 * scrollTop=0  → distanceFromBottom = 800 > 200 → scrolled up  → showScrollButton true
 * scrollTop=750 → distanceFromBottom = 50  ≤ 50  → pinned       → showScrollButton false
 */
function buildScrollEl(): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { get: () => 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => 200, configurable: true });
  el.scrollTop = 750; // start near bottom
  return el;
}

function fireScroll(el: HTMLDivElement, scrollTop: number) {
  el.scrollTop = scrollTop;
  el.dispatchEvent(new Event('scroll'));
}

describe('useScrollPin — initial state', () => {
  it('starts pinned with no scroll button', () => {
    const { result } = renderHook(() => useScrollPin());
    expect(result.current.showScrollButton).toBe(false);
    expect(result.current.hasNewContent).toBe(false);
    expect(result.current.isPinned).toBe(true);
  });

  it('notifyNewContent does not arm hasNewContent when already at bottom (scrolledUpRef=false)', () => {
    const { result } = renderHook(() => useScrollPin());
    act(() => { result.current.notifyNewContent(); });
    expect(result.current.hasNewContent).toBe(false);
    expect(result.current.showScrollButton).toBe(false);
  });
});

describe('useScrollPin — regression: jump button missing on finished transcript (D4 bug)', () => {
  /**
   * Invariant: showScrollButton must be true whenever the user is scrolled up,
   * regardless of whether new content has arrived.
   *
   * D4 had: showScrollButton = hasNewContent && scrolledUp — this hid the button
   * when reading history with no new content, leaving no way back to the bottom.
   * Fix: showScrollButton = isScrolledUp (always visible when far from bottom).
   */
  it('showScrollButton is true when scrolled up through finished transcript (no notifyNewContent)', () => {
    const el = buildScrollEl();
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const pin = useScrollPin();
      // Seed ref synchronously during render so the effect's addEventListener fires on el.
      if (!pin.containerRef.current) pin.containerRef.current = el;
      return pin;
    });

    // Start pinned near bottom — no button.
    act(() => { fireScroll(el, 750); });
    expect(result.current.showScrollButton).toBe(false);
    expect(result.current.isPinned).toBe(true);

    // Scroll to top (distanceFromBottom=800 > 200): button must appear without new content.
    act(() => { fireScroll(el, 0); });
    expect(result.current.showScrollButton).toBe(true);
    expect(result.current.hasNewContent).toBe(false); // no notifyNewContent called

    // scrollToBottom clears state.
    act(() => {
      result.current.scrollToBottom();
      fireScroll(el, 750);
    });
    expect(result.current.showScrollButton).toBe(false);

    document.body.removeChild(el);
  });

  it('hasNewContent becomes true ("New messages" label) when notifyNewContent called while scrolled up', () => {
    const el = buildScrollEl();
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const pin = useScrollPin();
      if (!pin.containerRef.current) pin.containerRef.current = el;
      return pin;
    });

    // Scroll up first.
    act(() => { fireScroll(el, 0); });
    expect(result.current.showScrollButton).toBe(true);
    expect(result.current.hasNewContent).toBe(false);

    // New content arrives while scrolled up → "New messages" label.
    act(() => { result.current.notifyNewContent(); });
    expect(result.current.hasNewContent).toBe(true);
    expect(result.current.showScrollButton).toBe(true);

    // Scroll back to bottom → both flags clear.
    act(() => { fireScroll(el, 750); });
    expect(result.current.hasNewContent).toBe(false);
    expect(result.current.showScrollButton).toBe(false);
    expect(result.current.isPinned).toBe(true);

    document.body.removeChild(el);
  });

  it('notifyNewContent does NOT arm hasNewContent when pinned (at bottom)', () => {
    const el = buildScrollEl();
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const pin = useScrollPin();
      if (!pin.containerRef.current) pin.containerRef.current = el;
      return pin;
    });

    // Fire a pinned scroll event first (scrollTop=750 → distanceFromBottom=50 ≤ 50).
    act(() => { fireScroll(el, 750); });
    expect(result.current.showScrollButton).toBe(false);

    // notifyNewContent while pinned must not arm content.
    act(() => { result.current.notifyNewContent(); });
    expect(result.current.hasNewContent).toBe(false);

    document.body.removeChild(el);
  });
});

describe('useScrollPin — regression: layout scroll events must not unpin (fan-in turn-3 blank)', () => {
  /**
   * A viewport resize (phone rotation) or the pill's padding toggle fires a
   * scroll event with a changed geometry but no upward user scroll. Before the
   * fix that event unpinned the transcript 93 px above the bottom (no pill:
   * under the 200 px threshold), so the next turn streamed below the fold.
   */
  function mutableEl(): { el: HTMLDivElement; size: { height: number; client: number } } {
    const size = { height: 1000, client: 200 };
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => size.height, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => size.client, configurable: true });
    el.scrollTop = 800;
    return { el, size };
  }

  it('stays pinned and re-pins to the bottom when content grows without a user scroll', () => {
    const { el, size } = mutableEl();
    document.body.appendChild(el);
    const { result } = renderHook(() => {
      const pin = useScrollPin();
      if (!pin.containerRef.current) pin.containerRef.current = el;
      return pin;
    });
    act(() => { fireScroll(el, 800); });
    expect(result.current.isPinned).toBe(true);

    // Reflow: content grows 600 px, scrollTop unchanged (distance 600 > thresholds).
    size.height = 1600;
    act(() => { el.dispatchEvent(new Event('scroll')); });
    expect(result.current.isPinned).toBe(true);
    expect(result.current.showScrollButton).toBe(false);
    expect(el.scrollTop).toBe(1600); // re-pinned (jsdom does not clamp)

    // A genuine upward user scroll still releases the pin.
    act(() => { fireScroll(el, 100); });
    expect(result.current.isPinned).toBe(false);
    expect(result.current.showScrollButton).toBe(true);
    document.body.removeChild(el);
  });
});

describe('useScrollPin — regression: reload with ?session= stayed at the top (smoke-stream reload)', () => {
  /**
   * After a reload, transcript items can land before the session list, so the
   * items effect scrolls an empty pane; the transcript renders once the list
   * resolves, with no data dependency changing. Growth with no scroll event must
   * still re-pin while pinned, and must not when the user has scrolled up.
   */
  function setup() {
    const observers: Array<() => void> = [];
    const prev = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb: () => void) { observers.push(cb); } observe() {} unobserve() {} disconnect() {} } as never;
    const size = { height: 844, client: 751 };
    const el = document.createElement('div');
    el.appendChild(document.createElement('div'));
    Object.defineProperty(el, 'scrollHeight', { get: () => size.height, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => size.client, configurable: true });
    el.scrollTop = 0;
    document.body.appendChild(el);
    const hook = renderHook(() => {
      const pin = useScrollPin();
      if (!pin.containerRef.current) pin.containerRef.current = el;
      return pin;
    });
    const grow = (h: number) => { size.height = h; act(() => { for (const cb of observers) cb(); }); };
    const restore = () => { globalThis.ResizeObserver = prev; document.body.removeChild(el); hook.unmount(); };
    return { el, hook, grow, restore, observers };
  }

  it('re-pins to the bottom when content grows with no scroll event', () => {
    const { el, grow, restore, observers } = setup();
    expect(observers.length).toBe(1);
    grow(4380);
    expect(el.scrollTop).toBe(4380);
    restore();
  });

  it('leaves the position alone when the user has scrolled up', () => {
    const { el, hook, grow, restore } = setup();
    grow(4380);
    act(() => { el.scrollTop = 100; el.dispatchEvent(new Event('scroll')); });
    expect(hook.result.current.isPinned).toBe(false);
    grow(6000);
    expect(el.scrollTop).toBe(100);
    restore();
  });
});

describe('content removal is not a user scroll-up', () => {
  it('stays pinned when Retry/edit shrinks the content and the browser clamps scrollTop down', () => {
    const el = buildScrollEl();
    document.body.appendChild(el);
    const { result } = renderHook(() => {
      const pin = useScrollPin();
      if (!pin.containerRef.current) pin.containerRef.current = el;
      return pin;
    });
    act(() => { fireScroll(el, 750); });
    expect(result.current.isPinned).toBe(true);
    // Items removed: content shrinks from 1000 to 600 and scrollTop lands 100px above the bottom.
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 600 });
    act(() => { fireScroll(el, 300); });
    expect(result.current.isPinned).toBe(true);
    expect(result.current.showScrollButton).toBe(false);
    document.body.removeChild(el);
  });
});
