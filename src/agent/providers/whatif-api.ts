// Stable public API for whatif/ and other consumers outside providers/
//
// Thin re-exports from leaf modules — bypasses the omnibus providers/index.ts
// barrel so importing this file does NOT trigger module-level singletons
// (e.g. openaiCompatibleProvider) that would break CLI test suites.
//
// If an underlying file is reorganised (e.g. adding a second direct provider),
// only this file needs updating — not every consumer.

export { deriveCallCostUsd } from './anthropic-direct/pricing.js';
export type { CacheWriteSplit, ModelPricing, SpeedPricingContext } from './anthropic-direct/pricing.js';
export { oneShotCompletion, oneShotCompletionWithStop } from './anthropic-direct/oneshot.js';
export type { OneShotInput, OneShotStopReason } from './anthropic-direct/oneshot.js';
export { resolveModelId } from '../session/model-resolution.js';
