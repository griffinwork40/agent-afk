/**
 * Shared model-argument validation for all `/model`-switching surfaces
 * (REPL, Telegram, and any future surface).
 *
 * Centralises the accept/reject predicate so REPL and Telegram cannot drift —
 * both import {@link isValidModelArg} rather than re-implementing it.
 *
 * @module agent/session/model-validate
 */

import { providerForModel } from '../providers/index.js';
import { MODEL_ALIASES_HINT, resolveBinding, slotForInput } from './model-slots.js';
import type { AgentModelInput } from '../types.js';

/**
 * Returns `true` when `model` is a valid, routable model argument that the
 * `/model` command (REPL or Telegram) should accept:
 *
 * - A known alias or slot tier name (from {@link MODEL_ALIASES_HINT})
 * - A user-defined custom slot name (resolved by {@link slotForInput})
 * - An `openai-compatible` wire id (any `org/model`, GPT, o-series, etc.)
 * - An `xai` / `xai-oauth` wire id (`grok-*` family)
 * - A raw Anthropic wire id (`claude-*`)
 *
 * Bare unknown strings (typos, unsupported providers) return `false` — they
 * would silently reach the provider layer and surface as opaque API errors.
 */
export function isValidModelArg(model: AgentModelInput): boolean {
  if (MODEL_ALIASES_HINT.includes(model)) return true;
  if (slotForInput(model) !== undefined) return true;
  const routed = providerForModel(model);
  if (routed === 'openai-compatible') return true;
  if (routed === 'xai' || routed === 'xai-oauth') return true;
  // Raw Anthropic wire id (e.g. `claude-sonnet-4-6`, `claude-opus-5`).
  const resolvedId = resolveBinding(model).id.trim().toLowerCase();
  return resolvedId.startsWith('claude-') || resolvedId.startsWith('claude_');
}
