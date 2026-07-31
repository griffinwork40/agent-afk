/**
 * Re-export shim — the canonical implementation has moved to
 * `../../shared/date-rollover.ts`.
 *
 * This file is kept so existing imports (`./date-rollover.js` from
 * `query.ts`) continue to resolve without modification.
 *
 * @module agent/providers/anthropic-direct/query/date-rollover
 */

export {
  refreshEnvironmentDate,
} from '../../shared/date-rollover.js';
