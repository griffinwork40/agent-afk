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

/**
 * Canonical short-alias → full model-ID mapping.
 *
 * Exported so `src/agent/providers/index.ts` can derive `CLAUDE_SHORT_ALIASES`
 * from this map rather than maintaining a separate enumeration that can drift.
 * The `readonly` assertion prevents accidental mutation by importers.
 */
export const MODEL_MAP: Readonly<Record<ClaudeModel, string>> = {
  opus: 'claude-opus-4-8',
  opus_1m: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  sonnet_1m: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
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

export function resolveModelId(model: AgentModelInput | undefined): string | undefined {
  if (model === undefined) return undefined;
  if (typeof model === 'string' && isValidModel(model)) {
    return getModelId(model);
  }
  return model;
}
