/**
 * Default subagent model policy (#3442). Relocated from
 * `src/cli/shared-helpers.ts` (which re-exports it) so agent-layer callers such
 * as `createWiredExecutors` can resolve it without importing `src/cli`.
 *
 * @module agent/session/default-subagent-model
 */
import { providerForModel } from '../providers/index.js';
import type { AgentModelInput } from '../types.js';
import { env } from '../../config/env.js';

/**
 * Get the default model for dispatched subagents (`agent` and `skill` tools).
 *
 * Precedence:
 *   1. `AFK_DEFAULT_SUBAGENT_MODEL` env (when set, always wins).
 *   2. If the parent session routes to `openai-compatible` (any non-Claude
 *      provider — GPT/o-series, codex-*, HF-style local ids) → return the
 *      parent model. Without this, a local-only setup silently dispatches
 *      subagents to api.anthropic.com because the literal `'medium'` fallback
 *      below routes back through `providerForModel` → `anthropic-direct`.
 *   3. `'medium'` (the medium capability tier). Preserved for Claude parents so
 *      the historical cost-management intent — "high-tier parent (e.g. opus)
 *      shouldn't auto-spawn high-tier children" — keeps working; and because it
 *      is the rebindable TIER (not the fixed `'sonnet'` identity alias), a user
 *      who rebinds `medium` redirects default subagents along with it.
 *
 * The `parentModel` arg is what enables (2); callers that don't pass it
 * (legacy / test) get the original env-var-or-`'medium'` behavior.
 *
 * Pass-through like `getModel()` — short aliases and provider-native ids both
 * work.
 */
export function getDefaultSubagentModel(parentModel?: AgentModelInput): AgentModelInput {
  const raw = env.AFK_DEFAULT_SUBAGENT_MODEL;
  if (raw && raw.length > 0) return raw;
  if (typeof parentModel === 'string') {
    const parentProvider = providerForModel(parentModel);
    // Inherit parent for OpenAI-compatible and xAI/Grok families so local/Grok
    // sessions do not silently fork Anthropic `medium` children.
    if (
      parentProvider === 'openai-compatible'
      || parentProvider === 'xai'
      || parentProvider === 'xai-oauth'
    ) {
      return parentModel;
    }
  }
  return 'medium';
}
