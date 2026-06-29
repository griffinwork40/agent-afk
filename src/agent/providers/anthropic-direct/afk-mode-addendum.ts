/**
 * Re-export shim — the canonical implementation has moved to
 * `../shared/afk-mode-addendum.ts`.
 *
 * This file is kept so existing test imports
 * (`./afk-mode-addendum.js` from `afk-mode-addendum.test.ts` and
 *  `plan-mode-system-payload.test.ts`) continue to resolve without
 * modification.
 *
 * @module agent/providers/anthropic-direct/afk-mode-addendum
 */

export {
  AFK_MODE_ADDENDUM_TEXT,
  buildAfkModeAddendumBlock,
} from '../shared/afk-mode-addendum.js';
