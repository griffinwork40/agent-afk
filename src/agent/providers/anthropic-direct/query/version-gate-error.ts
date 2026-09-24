/**
 * Actionable message for the Anthropic API's Claude Code version gate (#2075).
 *
 * In OAuth mode agent-afk identifies itself as a Claude Code CLI release via
 * {@link CLI_USER_AGENT} and the `cc_version` in `BILLING_HEADER_TEXT`
 * (`../auth.ts`). When the API decides that release is too old for a model or
 * feature, it rejects the request with a `claude_code_version_too_old` error.
 * Raw, that error names neither the constant to bump nor where it lives, so
 * the operator is left guessing. This annotator prepends a fix-it line.
 */
import { CLI_USER_AGENT } from '../auth.js';

/** Error code the API returns when the advertised Claude Code version is too old. */
export const VERSION_GATE_ERROR_CODE = 'claude_code_version_too_old';

/** Prefix marking an error annotated by {@link annotateVersionGateError}. */
export const VERSION_GATE_ERROR_PREFIX = '[Claude Code version gate]';

/** True when `error` is the API's Claude Code version-gate rejection. */
export function isVersionGateError(error: Error): boolean {
  if (error.message.includes(VERSION_GATE_ERROR_CODE)) return true;
  // The SDK's APIError carries the parsed response body on `.error`; the code
  // may live there even when the message was shortened.
  const body = (error as Error & { error?: unknown }).error;
  if (body === undefined || body === null) return false;
  try {
    return JSON.stringify(body).includes(VERSION_GATE_ERROR_CODE);
  } catch {
    return false;
  }
}

/** Human-readable fix-it text naming the constants to bump. */
export function versionGateHint(): string {
  return (
    `${VERSION_GATE_ERROR_PREFIX} The API rejected this request because agent-afk ` +
    `advertises an older Claude Code release (${CLI_USER_AGENT}). Update CLI_USER_AGENT ` +
    `and the matching cc_version in BILLING_HEADER_TEXT ` +
    `(src/agent/providers/anthropic-direct/auth.ts) to the current release ` +
    `(\`npm view @anthropic-ai/claude-code version\`), then rebuild. Original error:`
  );
}

/**
 * Copy `original` into a new Error with `message` replaced, keeping every own
 * property (status, headers, error, requestID, ...) and linking `cause`.
 *
 * Invariant: downstream classifiers (auth refresh on 401, usage-limit tiers on
 * 429, overload handling on 529/503) key off own properties of the thrown SDK
 * error, so a bare `new Error(msg)` silently disables them. Every message
 * rewrite in this provider must go through a property-preserving copy.
 */
export function rewrapWithMessage(original: Error, message: string): Error {
  const annotated = new Error(message, { cause: original });
  annotated.name = original.name;
  if (original.stack !== undefined) annotated.stack = original.stack;
  for (const key of Object.getOwnPropertyNames(original) as Array<keyof Error>) {
    if (key === 'message' || key === 'stack') continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor !== undefined) Object.defineProperty(annotated, key, descriptor);
  }
  return annotated;
}

/**
 * Prepend {@link versionGateHint} when `error` is a version-gate rejection;
 * return any other error unchanged. Idempotent: an already-annotated error is
 * returned as-is.
 */
export function annotateVersionGateError(error: Error): Error {
  if (error.message.includes(VERSION_GATE_ERROR_PREFIX)) return error;
  if (!isVersionGateError(error)) return error;
  return rewrapWithMessage(error, `${versionGateHint()} ${error.message}`);
}
