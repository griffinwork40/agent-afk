/**
 * Session-flag validation helpers for `afk chat`.
 *
 * Extracted from chat.ts to bring `registerChatCommand` under the 200-line
 * function ceiling (#1865).  Exports:
 *   - `validateSessionFlags`  mutual-exclusion + UUID + duplicate checks
 *   - `resolveMessage`        stdin / positional-arg message resolution
 */

import { readStdin } from './chat.stdin-stream.js';
import { findSession } from '../session-store.js';

// ---------------------------------------------------------------------------
// Session-flag validation
// ---------------------------------------------------------------------------

/**
 * Check mutual-exclusion rules for --resume / --continue / --session-id and
 * write a human-readable error to stderr when a violation is found.
 *
 * Returns `true` when validation passes, `false` (with `process.exitCode = 1`
 * already set) when it fails.
 */
export function validateSessionFlags(options: {
  resume?: string;
  continue?: boolean;
  sessionId?: string;
}): boolean {
  if (options.resume && options.continue) {
    process.stderr.write('Error: --resume and --continue are mutually exclusive\n');
    process.exitCode = 1;
    return false;
  }
  if (options.sessionId !== undefined && (options.resume || options.continue)) {
    process.stderr.write('Error: --session-id is mutually exclusive with --resume and --continue\n');
    process.exitCode = 1;
    return false;
  }
  if (options.sessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.sessionId)) {
    process.stderr.write(`Error: --session-id must be a UUID (got: ${options.sessionId})\n`);
    process.exitCode = 1;
    return false;
  }
  if (options.sessionId !== undefined) {
    const existing = findSession(options.sessionId);
    if (existing !== undefined) {
      process.stderr.write(`Error: session already exists: ${options.sessionId} — use --resume to continue it\n`);
      process.exitCode = 1;
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Message resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the user message from the positional argument, `-` (explicit stdin
 * sentinel), or piped stdin.  Returns the resolved non-empty message string,
 * or `null` (with `process.exitCode = 1`) when resolution fails.
 */
export async function resolveMessage(rawMessage: string | undefined): Promise<string | null> {
  const stdinIsPipe = !process.stdin.isTTY;

  let message: string;
  if (rawMessage === '-') {
    if (!stdinIsPipe) {
      process.stderr.write('Error: no stdin available — pass a message or pipe one in\n');
      process.exitCode = 1;
      return null;
    }
    message = await readStdin();
  } else if (rawMessage === undefined && stdinIsPipe) {
    message = await readStdin();
  } else if (rawMessage !== undefined) {
    message = rawMessage;
  } else {
    process.stderr.write('Error: missing message — pass a message argument or pipe via stdin\n');
    process.exitCode = 1;
    return null;
  }

  if (message.trim() === '') {
    process.stderr.write('Error: message is empty — stdin contained only whitespace\n');
    process.exitCode = 1;
    return null;
  }

  return message;
}
