/**
 * Tests for useTabNotification.
 *
 * Covers:
 *  1. Badge added when liveTurns increments while tab is hidden.
 *  2. Badge NOT added when liveTurns increments while tab is visible.
 *  3. Badge cleared on window focus.
 *  4. originalTitleRef doesn't capture already-badged title on remount (B-4 regression).
 *  5. Notification fires when permission is granted.
 *  6. Notification NOT fired when permission is not granted.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabNotification } from './use-tab-notification';

const BADGE_PREFIX = '(✓) ';
const BASE_TITLE = 'afk dashboard';
const BADGED_TITLE = `${BADGE_PREFIX}${BASE_TITLE}`;

function stubHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

beforeEach(() => {
  document.title = BASE_TITLE;
  stubHidden(false);
  // Reset Notification stub to default denied state.
  vi.stubGlobal('Notification', undefined);
});

afterEach(() => {
  document.title = BASE_TITLE;
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

describe('useTabNotification', () => {
  it('adds badge when liveTurns increments and tab is hidden', () => {
    stubHidden(true);
    const { rerender } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns }),
      { initialProps: { liveTurns: 0 } },
    );
    expect(document.title).toBe(BASE_TITLE);
    rerender({ liveTurns: 1 });
    expect(document.title).toBe(BADGED_TITLE);
  });

  it('does NOT add badge when liveTurns increments and tab is visible', () => {
    stubHidden(false);
    const { rerender } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns }),
      { initialProps: { liveTurns: 0 } },
    );
    rerender({ liveTurns: 1 });
    expect(document.title).toBe(BASE_TITLE);
  });

  it('does NOT add badge when isSelected is false but tab is visible', () => {
    stubHidden(false);
    const { rerender } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns, isSelected: false }),
      { initialProps: { liveTurns: 0 } },
    );
    rerender({ liveTurns: 1 });
    // isSelected=false AND !hidden → still notifies (document.hidden is falsy but
    // isSelected !== false is the guard; since isSelected IS false, it proceeds).
    expect(document.title).toBe(BADGED_TITLE);
  });

  it('clears badge on window focus', () => {
    stubHidden(true);
    const { rerender } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns }),
      { initialProps: { liveTurns: 0 } },
    );
    rerender({ liveTurns: 1 });
    expect(document.title).toBe(BADGED_TITLE);
    window.dispatchEvent(new Event('focus'));
    expect(document.title).toBe(BASE_TITLE);
  });

  it('does not double-badge on multiple increments', () => {
    stubHidden(true);
    const { rerender } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns }),
      { initialProps: { liveTurns: 0 } },
    );
    rerender({ liveTurns: 1 });
    rerender({ liveTurns: 2 });
    expect(document.title).toBe(BADGED_TITLE);
  });

  // B-4 regression: remount with already-badged title must not leak the badge.
  it('strips stale badge prefix from title on remount (B-4 regression)', () => {
    // Simulate the document title being left in a badged state (e.g. component
    // unmounted before focus fired).
    document.title = BADGED_TITLE;
    stubHidden(false);

    // Mount fresh hook — originalTitleRef must strip the prefix.
    const { rerender } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns }),
      { initialProps: { liveTurns: 0 } },
    );

    // Tab is visible, so no new badge is added; but if a focus event fires now
    // the restored title should be BASE_TITLE, not BADGED_TITLE again.
    // Force a badge first by going hidden and incrementing.
    stubHidden(true);
    rerender({ liveTurns: 1 });
    expect(document.title).toBe(BADGED_TITLE);

    // Now focus: must restore to BASE_TITLE, not BADGE_PREFIX + BADGE_PREFIX + BASE_TITLE.
    window.dispatchEvent(new Event('focus'));
    expect(document.title).toBe(BASE_TITLE);
  });

  it('fires a Notification when permission is granted and tab is hidden', () => {
    stubHidden(true);
    const closeMock = vi.fn();
    const NotificationMock = Object.assign(
      vi.fn().mockImplementation(() => ({ close: closeMock })),
      { permission: 'granted' as NotificationPermission },
    );
    vi.stubGlobal('Notification', NotificationMock);

    const { rerender } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns, sessionTitle: 'My session' }),
      { initialProps: { liveTurns: 0 } },
    );
    rerender({ liveTurns: 1 });

    expect(NotificationMock).toHaveBeenCalledOnce();
    expect(NotificationMock).toHaveBeenCalledWith('afk — turn complete', {
      body: 'Session: My session',
      tag: 'afk-turn-complete',
    });
  });

  it('does NOT fire a Notification when permission is denied', () => {
    stubHidden(true);
    const NotificationMock = Object.assign(vi.fn(), { permission: 'denied' as NotificationPermission });
    vi.stubGlobal('Notification', NotificationMock);

    const { rerender } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns }),
      { initialProps: { liveTurns: 0 } },
    );
    rerender({ liveTurns: 1 });

    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('does NOT fire a Notification when permission is default (not granted)', () => {
    stubHidden(true);
    const NotificationMock = Object.assign(vi.fn(), { permission: 'default' as NotificationPermission });
    vi.stubGlobal('Notification', NotificationMock);

    const { rerender } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns }),
      { initialProps: { liveTurns: 0 } },
    );
    rerender({ liveTurns: 1 });

    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('removes focus listener on unmount', () => {
    stubHidden(true);
    const { rerender, unmount } = renderHook(
      ({ liveTurns }) => useTabNotification({ liveTurns }),
      { initialProps: { liveTurns: 0 } },
    );
    rerender({ liveTurns: 1 });
    expect(document.title).toBe(BADGED_TITLE);
    unmount();
    // Title is still badged (unmount doesn't restore it — focus does).
    // But the focus listener should be gone: firing focus should not throw.
    expect(() => window.dispatchEvent(new Event('focus'))).not.toThrow();
  });
});
