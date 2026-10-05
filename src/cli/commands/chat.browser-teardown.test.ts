/**
 * Unit tests for the `closeLazyBrowser` teardown helper (issue #2580).
 *
 * The browser registry is mocked so no real Playwright / Chromium process is
 * launched.  Tests verify:
 *   - closeLazyBrowser() is a no-op when no browser was ever launched.
 *   - closeLazyBrowser() calls closeBrowserProvider() when a browser is active.
 *   - closeLazyBrowser() swallows errors from closeBrowserProvider() so the
 *     caller's finally block is never interrupted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the browser registry so no real Playwright is imported.
// ---------------------------------------------------------------------------

const mockBrowserProviderActive = vi.fn<[], boolean>();
const mockCloseBrowserProvider = vi.fn<[], Promise<void>>();

vi.mock('../../browser/registry.js', () => ({
  browserProviderActive: mockBrowserProviderActive,
  closeBrowserProvider: mockCloseBrowserProvider,
}));

// Import AFTER mocks are installed.
import { closeLazyBrowser } from './chat.browser-teardown.js';

// ---------------------------------------------------------------------------
// Reset mocks between tests.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockCloseBrowserProvider.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('closeLazyBrowser()', () => {
  it('is a no-op when no browser has been launched (browserProviderActive returns false)', async () => {
    mockBrowserProviderActive.mockReturnValue(false);

    await expect(closeLazyBrowser()).resolves.toBeUndefined();

    expect(mockCloseBrowserProvider).not.toHaveBeenCalled();
  });

  it('calls closeBrowserProvider() when a browser is active', async () => {
    mockBrowserProviderActive.mockReturnValue(true);
    mockCloseBrowserProvider.mockResolvedValue(undefined);

    await expect(closeLazyBrowser()).resolves.toBeUndefined();

    expect(mockCloseBrowserProvider).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from closeBrowserProvider() so finally blocks are not interrupted', async () => {
    mockBrowserProviderActive.mockReturnValue(true);
    mockCloseBrowserProvider.mockRejectedValue(new Error('browser shutdown exploded'));

    // Must resolve, never reject.
    await expect(closeLazyBrowser()).resolves.toBeUndefined();
  });

  it('does not call closeBrowserProvider() a second time when browser is inactive', async () => {
    // Simulate: first call shuts down (active), second call is a no-op.
    mockBrowserProviderActive
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await closeLazyBrowser();
    await closeLazyBrowser();

    expect(mockCloseBrowserProvider).toHaveBeenCalledTimes(1);
  });
});
