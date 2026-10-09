/**
 * External-effect ledger — public API surface.
 *
 * The ledger records every external side effect (Telegram send, GitHub PR
 * creation, MCP write, outbound bash command, etc.) before and after
 * execution, deduplicates via idempotency keys, and tracks ambiguous
 * outcomes for future reconciliation.
 *
 * ## Quick start
 *
 * ```ts
 * // In default-hook-registry.ts:
 * import { createEffectLedgerPreHook, createEffectLedgerPostHook } from './effect-ledger/index.js';
 * registry.register('PreToolUse', createEffectLedgerPreHook());
 * registry.register('PostToolUse', createEffectLedgerPostHook());
 * ```
 *
 * ## Injectable seam (not re-exported from this barrel)
 *
 * `EffectStore` is accepted as an injectable parameter by both hook factories
 * above (e.g. for testing with a custom store), but it is not re-exported
 * from this barrel.  Import it directly from `./store.js` when injecting a
 * custom store or writing tests.
 *
 * ## Truly internal helpers (not re-exported)
 *
 * `classifyToolCall` and `computeIdempotencyKey` are implementation details
 * consumed by the hook factories and are intentionally NOT part of any public
 * surface.  Import them directly from `./classifier.js` and `./idempotency.js`
 * only if you are extending the ledger internals.
 *
 * @module agent/effect-ledger
 */

export { createEffectLedgerPostHook, createEffectLedgerPreHook } from './hook.js';
export type {
  EffectRecord,
  EffectStatus,
  EffectQuery,
  PendingEffectInput,
  ExecuteEffectInput,
} from './types.js';
export type { Classification } from './classifier.js';
