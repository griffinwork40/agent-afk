/**
 * Runtime model resolution helpers.
 *
 * Owns the canonical short-name → full-id mapping for Anthropic models and
 * exposes validation + normalization helpers. Lives inside the agent module
 * so the harness does not need to reach back into CLI-specific code.
 *
 * @module agent/session/model-resolution
 */

import type { AgentModelInput, ClaudeModel } from '../types.js';
import { DEFAULT_SLOT_BINDINGS, resolveModelInput } from './model-slots.js';

/**
 * Canonical short-alias → full model-ID mapping for the built-in Claude
 * aliases. Derived from {@link DEFAULT_SLOT_BINDINGS} so the legacy alias table
 * and the slot defaults cannot drift. Retained for the call sites that still
 * key on the legacy alias set (`providers/index.ts` `CLAUDE_SHORT_ALIASES`,
 * `model-limits.ts`, and CLI casing-normalization). The `readonly` assertion
 * prevents accidental mutation by importers.
 *
 * Note: actual model selection now flows through the slot resolver
 * ({@link resolveModelId} → `resolveModelInput`), which honors user rebindings
 * of these aliases. `MODEL_MAP` reflects only the *default* bindings.
 */
export const MODEL_MAP: Readonly<Record<ClaudeModel, string>> = {
  opus: DEFAULT_SLOT_BINDINGS.large.id,
  opus_1m: DEFAULT_SLOT_BINDINGS.large.id,
  sonnet: DEFAULT_SLOT_BINDINGS.medium.id,
  sonnet_1m: DEFAULT_SLOT_BINDINGS.medium.id,
  haiku: DEFAULT_SLOT_BINDINGS.small.id,
};

export function isValidModel(model: string): model is ClaudeModel {
  return model in MODEL_MAP;
}

export function getModelId(shortName: ClaudeModel): string {
  const modelId = MODEL_MAP[shortName];
  if (!modelId) {
    throw new Error(`Invalid model: ${shortName}`);
  }
  return modelId;
}

/**
 * Resolve a model input to the concrete id sent to the provider SDK. Delegates
 * to the slot resolver so user-configured tier rebindings (small/medium/large,
 * custom names, and the legacy haiku/sonnet/opus aliases) all expand to their
 * bound id. Raw ids and the `auto` sentinel pass through unchanged.
 */
export function resolveModelId(model: AgentModelInput | undefined): string | undefined {
  return resolveModelInput(model);
}
