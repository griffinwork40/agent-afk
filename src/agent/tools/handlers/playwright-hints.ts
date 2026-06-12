/**
 * Shared Playwright-availability detection + install-hint messaging for the
 * `browser_*` tool handlers.
 *
 * Two distinct failure modes are surfaced with DIFFERENT remedies:
 *   - the `playwright` package is not installed → `pnpm add playwright`
 *   - the package is present but the chromium browser binary was never
 *     downloaded → `pnpm exec playwright install chromium`
 *
 * History: the chromium-missing hint ("Executable doesn't exist") lived in
 * web-scrape.ts but was absent from the five browser_* handlers, so a user who
 * had `playwright` installed but no chromium binary got an opaque
 * `... failed to get provider: Executable doesn't exist at ...` error with no
 * remedy. The hint list was also copy-pasted into all five handlers, so any fix
 * had to land in five places. Centralizing both the substrings and the message
 * here keeps them from drifting apart again.
 *
 * @module agent/tools/handlers/playwright-hints
 */

import type { ToolFailureClass } from '../../trace/types.js';

/**
 * Classify a thrown browser error as a navigation/action timeout, for the
 * `failureClass` field on the tool result. Playwright raises a `TimeoutError`
 * (`name === 'TimeoutError'`) from `page.goto` and locator waits; the message
 * regex is a defensive fallback for errors that lost their prototype across a
 * boundary. Returns `'timeout'` for timeouts, `undefined` otherwise — an
 * unclassified browser failure still counts as a real failure downstream, so
 * this only ever DEMOTES a timeout out of the "real fault" bucket, never
 * promotes a genuine error into a benign class.
 */
export function browserTimeoutFailureClass(err: unknown): ToolFailureClass | undefined {
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  const msg = err instanceof Error ? err.message : String(err);
  return /Timeout\s+\d+\s*ms exceeded/i.test(msg) ? 'timeout' : undefined;
}

// Substrings in a thrown error message that indicate the optional Playwright
// peer dependency — or its chromium browser binary — is unavailable.
export const PLAYWRIGHT_MISSING_HINTS = [
  'Cannot find package',
  'ERR_MODULE_NOT_FOUND',
  "Executable doesn't exist",
] as const;

/** True when `msg` indicates Playwright (the package or its chromium binary) is missing. */
export function isPlaywrightMissing(msg: string): boolean {
  return PLAYWRIGHT_MISSING_HINTS.some((hint) => msg.includes(hint));
}

/**
 * Returns the install hint appropriate to which half of the dependency is
 * absent. Assumes `isPlaywrightMissing(msg)` already returned true.
 */
export function playwrightMissingHint(msg: string): string {
  if (msg.includes("Executable doesn't exist")) {
    // Package is installed; the chromium browser binary was never downloaded.
    return (
      'browser tools require the Playwright chromium binary. ' +
      'Install via: pnpm exec playwright install chromium.'
    );
  }
  // The `playwright` package itself is not installed.
  return (
    'browser tools require the optional `playwright` peer dependency. ' +
    'Install via: pnpm add playwright (then pnpm exec playwright install chromium). ' +
    'Or pick a different tool.'
  );
}
