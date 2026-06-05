/**
 * Public API for the cli/errors module.
 *
 * `handleCommandError` is the convenience wrapper for CLI command catch blocks:
 * classify → present → process.exit.
 *
 * Use `presentError(classifyError(err))` directly in contexts where
 * process.exit must NOT be called (e.g. the interactive REPL's turn handler).
 *
 * @module cli/errors
 */

import { classifyError } from './classifier.js';
import { presentError } from './presenter.js';

/**
 * Classify, present, and exit. Intended for CLI command-level catch blocks.
 *
 * Never returns — always calls process.exit with the classified exit code.
 */
export function handleCommandError(err: unknown): never {
  const classified = classifyError(err);
  presentError(classified);
  process.exit(classified.exitCode);
}

export { classifyError } from './classifier.js';
export { presentError } from './presenter.js';
export type { ClassifiedError, ErrorKind } from './classifier.js';
