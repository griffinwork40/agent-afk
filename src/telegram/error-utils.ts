/**
 * Telegram error utilities — re-exports from canonical homes.
 *
 * The surface-agnostic predicates `isRateLimitError` / `isNetworkError`
 * moved to `src/utils/error-classifiers.ts` so the CLI error classifier can
 * use them without an upward import from `cli/` into `telegram/`.
 * The Anthropic usage-limit classifier lives next to the provider in
 * `src/agent/providers/anthropic-direct/usage-limit.ts`.
 *
 * This module remains as a single Telegram-side entry point that bundles
 * those re-exports so existing call sites (`./error-utils.js` imports
 * inside `src/telegram/`) keep working.
 *
 * @module telegram/error-utils
 */

import { classifyUsageLimitError } from '../agent/providers/anthropic-direct/usage-limit.js';
export type { UsageLimitClassification } from '../agent/providers/anthropic-direct/usage-limit.js';

/**
 * Classify a thrown error as a usage-limit event (OAuth subscription limit or
 * credit exhaustion). Thin wrapper over the provider-layer classifier so
 * Telegram streaming can format a friendly pause message without importing
 * provider internals directly.
 *
 * Returns `null` when the error is not a usage-limit error.
 */
export { classifyUsageLimitError as classifyUsageLimit };

export { isRateLimitError, isNetworkError } from '../utils/error-classifiers.js';
