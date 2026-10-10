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
 * import { createEffectLedgerPostHook } from './effect-ledger/index.js';
 * registry.register('PostToolUse', createEffectLedgerPostHook());
 * ```
 *
 * ## Internal helpers (not re-exported from this barrel)
 *
 * `EffectStore`, `EffectRecord`, `EffectStatus`, `EffectQuery`,
 * `PendingEffectInput`, `ExecuteEffectInput`, `Classification`,
 * `classifyToolCall`, and `computeIdempotencyKey` are implementation details.
 * Import them directly from `./store.js`, `./types.js`, `./classifier.js`, or
 * `./idempotency.js` only if you are extending the ledger internals.
 * `createEffectLedgerPreHook` is likewise internal — import directly from
 * `./hook.js` when needed.
 *
 * @module agent/effect-ledger
 */

export { createEffectLedgerPostHook } from './hook.js';
