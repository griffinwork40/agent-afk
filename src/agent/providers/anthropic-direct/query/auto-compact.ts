/**
 * Re-export shim — the canonical implementation has moved to
 * `../../shared/auto-compact.ts`.
 *
 * This file is kept so existing test imports
 * (`./auto-compact.js` from `auto-compact.test.ts`) and any other relative
 * importers inside the `anthropic-direct/` subtree continue to resolve
 * without modification.
 *
 * @module agent/providers/anthropic-direct/query/auto-compact
 */

export {
  computeUsedTokens,
  contextWindowTokensUsed,
  buildContextUsageFields,
  shouldAutoCompact,
} from '../../shared/auto-compact.js';

export type {
  ContextUsageApiBreakdown,
  ContextUsageFields,
} from '../../shared/auto-compact.js';
