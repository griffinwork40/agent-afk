/**
 * Playwright-availability messaging for the `browser_*` tool handlers, plus
 * browser timeout classification.
 *
 * The Playwright-missing detection and install-hint text now live in
 * `src/browser/playwright-missing.ts` and are re-exported here. That module is
 * the single source of truth: the low-level launcher decorates a failed
 * `chromium.launch()` with the same hint, and `src/browser/` cannot import
 * upward into the tool layer.
 *
 * History: the chromium-missing hint ("Executable doesn't exist") was wired
 * only into each handler's provider-CONSTRUCTION catch, which never sees a
 * launch failure — provider construction does not launch chromium. Issue #721
 * moved the check to the launch site itself. The re-exports below are kept so
 * the five handler call sites (and their tests) continue to compile unchanged.
 *
 * @module agent/tools/handlers/playwright-hints
 */

import type { ToolFailureClass } from '../../trace/types.js';

export {
  PLAYWRIGHT_MISSING_HINTS,
  isPlaywrightMissing,
  playwrightInstallCommand,
  playwrightMissingHint,
  decoratePlaywrightLaunchError,
  hasPlaywrightInstallHint,
  resetPlaywrightInstallCommandCache,
} from '../../../browser/playwright-missing.js';
export type { PlaywrightHintOptions } from '../../../browser/playwright-missing.js';

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
