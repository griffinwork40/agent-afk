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
 * // In default-hook-registry.ts, register the paired pre/post hooks:
 * const ledgerHooks = createEffectLedgerHooks();
 * registry.register('PreToolUse', ledgerHooks.pre);
 * registry.register('PostToolUse', ledgerHooks.post);
 * registry.register('PostToolUseFailure', ledgerHooks.post);
 * ```
 *
 * Both hooks share one store and in-flight call map.
 *
 * ## Injectable seam (not re-exported from this barrel)
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

export { createEffectLedgerHooks, createEffectLedgerPostHook } from './hook.js';
