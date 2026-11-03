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
import { getSlotBindings, type ModelSlots } from './model-slots.js';

/**
 * Get the default model for dispatched subagents (`agent` and `skill` tools).
 *
 * Precedence:
 *   1. `AFK_DEFAULT_SUBAGENT_MODEL` env (when set, always wins).
 *   2. `models.subagent` slot (afk.config.json or `AFK_MODEL_SUBAGENT` env).
 *      When configured, returns `'subagent'` so downstream slot resolution
 *      picks up the binding's per-slot baseUrl/apiKey/provider — enabling
 *      subagent inference routing to a different provider (Together, Fireworks,
 *      Groq, or a self-hosted vLLM/SGLang endpoint).
 *   3. If the parent session routes to `openai-compatible` (any non-Claude
 *      provider — GPT/o-series, codex-*, HF-style local ids) → return the
 *      parent model. Without this, a local-only setup silently dispatches
 *      subagents to api.anthropic.com because the literal `'medium'` fallback
 *      below routes back through `providerForModel` → `anthropic-direct`.
 *   4. `'medium'` (the medium capability tier). Preserved for Claude parents so
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
  // Check the `subagent` slot binding (afk.config.json models.subagent or
  // AFK_MODEL_SUBAGENT env). When configured, return the slot name so
  // downstream resolution picks up per-slot baseUrl/apiKey/provider.
  const subagentBinding = getSlotBindings().subagent;
  if (subagentBinding?.id && subagentBinding.id.length > 0) return 'subagent';
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

/**
 * Produce a human-readable label for the resolved default subagent model,
 * attributing the source (env var, subagent slot, or bare model name).
 *
 * Accepts the already-resolved `defaultModel` (from {@link getDefaultSubagentModel})
 * and the active `bindings` so callers do not re-derive the precedence logic.
 * Used by `buildAgentModelParamDescription` to annotate the `model` parameter
 * description without duplicating the precedence checks in this module.
 *
 * @param defaultModel - The value returned by {@link getDefaultSubagentModel}.
 * @param bindings - Active slot bindings (pass the result of {@link getSlotBindings}).
 */
export function describeDefaultSubagentModelSource(
  defaultModel: AgentModelInput,
  bindings: ModelSlots,
): string {
  // Source 1: AFK_DEFAULT_SUBAGENT_MODEL env var wins.
  const raw = env.AFK_DEFAULT_SUBAGENT_MODEL;
  if (raw && raw.length > 0) return `\`${String(defaultModel)}\` (from AFK_DEFAULT_SUBAGENT_MODEL)`;
  // Source 2: subagent slot configured.
  const subagentId = bindings.subagent?.id;
  if (subagentId && subagentId.length > 0) return `\`subagent\` slot → \`${subagentId}\``;
  // Source 3 & 4: parent-inherit or medium fallback — just show the model name.
  return `\`${String(defaultModel)}\``;
}
