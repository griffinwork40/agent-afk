/**
 * Per-model context and output-token limits — re-exports from the agent
 * layer.
 *
 * The tables themselves live in `src/agent/model-limits.ts` so providers
 * (notably `anthropic-direct`'s `getContextUsage()`) can compute a
 * percentage without depending on CLI code. This module preserves the
 * `src/cli/model-limits.ts` import surface for existing CLI consumers
 * (`shared.ts`, `info.ts`, `turn-handler.ts`).
 */

export {
  MODEL_CONTEXT_LIMITS,
  contextLimitFor,
  MODEL_MAX_OUTPUT_TOKENS,
  maxOutputTokensFor,
} from '../agent/model-limits.js';
