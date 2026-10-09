/**
 * Shared `execFileAsync` helper — a single `promisify(execFile)` instance
 * exported for callers that only need the default Node.js `execFile` wrapped
 * in a promise. Callers that need test-injectable execution (e.g. worktree,
 * branch-prune) should keep their own injectable function type instead.
 *
 * Usage:
 *   import { execFileAsync } from '../../utils/exec-file.js';
 *
 * Callers are responsible for their own timeouts and maxBuffer settings via
 * the options argument of `execFileAsync`.
 *
 * @module utils/exec-file
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Promisified version of Node's `child_process.execFile`.
 *
 * Equivalent to `promisify(execFile)` — provided as a shared export so each
 * module does not need to duplicate the
 * `import { execFile } from 'node:child_process'; const execFileAsync = promisify(execFile);`
 * boilerplate.
 *
 * Returns `{ stdout: string; stderr: string }` when options do not override
 * the encoding (Node default is `'buffer'`, but the promisified overload
 * resolves to string when no encoding option is set — callers that need binary
 * output should use `promisify(execFile)` directly).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const execFileAsync = promisify(execFile) as any as (
  file: string,
  args: readonly string[],
  options?: Parameters<typeof execFile>[2],
) => Promise<{ stdout: string; stderr: string }>;
