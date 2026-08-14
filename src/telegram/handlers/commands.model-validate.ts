/**
 * Accept/reject matrix for Telegram `/model <id>` (aliases, slots, wire ids).
 *
 * @module telegram/handlers/commands.model-validate
 */

import { providerForModel } from '../../agent/providers/index.js';
import {
  MODEL_ALIASES_HINT,
  resolveBinding,
  slotForInput,
} from '../../agent/session/model-slots.js';
import type { AgentModelInput } from '../../agent/types.js';

/** True when `model` is a known alias, slot name, or routable full wire id. */
export function isValidTelegramModelArg(model: AgentModelInput): boolean {
  if (MODEL_ALIASES_HINT.includes(model)) return true;
  if (slotForInput(model) !== undefined) return true;
  const routed = providerForModel(model);
  if (routed === 'openai-compatible') return true;
  if (routed === 'xai' || routed === 'xai-oauth') return true;
  // Raw Anthropic wire id (e.g. `claude-sonnet-5`).
  const resolvedId = resolveBinding(model).id.trim().toLowerCase();
  return resolvedId.startsWith('claude-') || resolvedId.startsWith('claude_');
}
