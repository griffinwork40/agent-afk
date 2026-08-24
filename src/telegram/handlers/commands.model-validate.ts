/**
 * Compatibility shim re-exporting {@link isValidModelArg} from
 * `agent/session/model-validate` for Telegram command handlers.
 *
 * The primary implementation lives in `agent/session/model-validate`; this
 * module is a thin re-export so Telegram handler imports do not need to reach
 * into the agent layer directly. REPL and Telegram accept exactly the same set
 * of model arguments — both delegate to the shared predicate.
 *
 * @module telegram/handlers/commands.model-validate
 */

import { isValidModelArg } from '../../agent/session/model-validate.js';
import type { AgentModelInput } from '../../agent/types.js';

/** True when `model` is a known alias, slot name, or routable full wire id. */
export function isValidTelegramModelArg(model: AgentModelInput): boolean {
  return isValidModelArg(model);
}
