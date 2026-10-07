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
