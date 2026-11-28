/**
 * Pre-classify a bash tool call's full raw command into the two boolean signals
 * that Done-evidence classification needs. Called at tool-dispatch time (before
 * the 160-char `toolInput` summary is applied) so classification sees the FULL
 * command. Only the two derived booleans flow through the event pipeline — the
 * raw command string is never stored or persisted.
 *
 * Returns `{}` for non-bash tools so callers can spread the result safely.
 *
 * @module agent/providers/shared/bash-classify
 */

import { classifyBashCommand } from '../../tools/readonly-bash.js';
import { isVerificationCommand } from '../../done-evidence.js';

/**
 * Extract the full command string from a bash tool input object.
 * Returns `undefined` when the input is not an object or has no `command` field.
 */
function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const cmd = (input as Record<string, unknown>)['command'];
  return typeof cmd === 'string' ? cmd : undefined;
}

/**
 * Pre-classify a bash tool call from its full raw input.
 *
 * Returns `{ isMutatingBash, isVerificationBash }` for `bash` calls, or `{}`
 * for all other tool names. The returned object is spread directly onto the
 * `tool.use.start` event so absent fields are never emitted for non-bash tools.
 */
export function classifyBashToolInput(
  toolName: string,
  input: unknown,
): { isMutatingBash?: boolean; isVerificationBash?: boolean } {
  if (toolName !== 'bash') return {};
  const cmd = extractCommand(input);
  if (cmd === undefined) return {};
  const isVerification = isVerificationCommand(cmd);
  const isMutating = isVerification
    ? false // verification commands are not treated as mutations by classifyDoneEvidence
    : classifyBashCommand(cmd).mutating;
  return { isMutatingBash: isMutating, isVerificationBash: isVerification };
}
