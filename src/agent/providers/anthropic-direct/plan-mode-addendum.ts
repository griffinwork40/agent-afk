/**
 * Re-export shim — the canonical implementation has moved to
 * `../shared/plan-mode-addendum.ts`.
 *
 * This file is kept so existing test imports
 * (`./plan-mode-addendum.js` from `plan-mode-addendum.test.ts`,
 *  `plan-mode-system-payload.test.ts`, and `openai-compatible/query.test.ts`)
 * continue to resolve without modification.
 *
 * @module agent/providers/anthropic-direct/plan-mode-addendum
 */

export {
  PLAN_MODE_ADDENDUM_TEXT,
  buildPlanModeAddendumBlock,
} from '../shared/plan-mode-addendum.js';
