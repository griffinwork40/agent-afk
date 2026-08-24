/**
 * Accept/reject matrix for Telegram `/model <id>` (aliases, slots, wire ids).
 *
 * Delegates to the shared {@link isValidModelArg} helper so REPL and Telegram
 * cannot drift — both surfaces accept exactly the same set of model arguments.
 *
 * @module telegram/handlers/commands.model-validate
 */

import { isValidModelArg } from '../../agent/session/model-validate.js';
import type { AgentModelInput } from '../../agent/types.js';

/** True when `model` is a known alias, slot name, or routable full wire id. */
export function isValidTelegramModelArg(model: AgentModelInput): boolean {
  return isValidModelArg(model);
}
