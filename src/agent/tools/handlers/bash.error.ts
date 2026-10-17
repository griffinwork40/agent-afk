/**
 * Spawn-error handler for the bash handler.
 *
 * Handles `proc.on('error', ...)`: translates ENOENT masquerade errors (dead
 * worktree / deleted cwd surfacing as `spawn /bin/sh ENOENT`) into
 * human-readable messages and settles the promise.
 *
 * Extracted from `createBashHandler` so that function stays under the 200-line
 * ceiling. All inputs are explicit parameters; no closures over hidden locals.
 *
 * @module agent/tools/handlers/bash.error
 */

import type { ChildProcess } from 'child_process';
import type { ToolHandlerContext } from '../types.js';
import { describeSpawnCwdError, isSpawnEnoent } from '../../../utils/spawn-cwd-error.js';

/** Parameters for {@link attachErrorHandler}. */
export interface AttachErrorHandlerParams {
  proc: ChildProcess;
  context: ToolHandlerContext | undefined;
  cwd: string | undefined;
  startedAt: number;
  settle: (result: { content: string; isError?: boolean; durationMs?: number }) => void;
}

/**
 * Attach an `error` listener to `proc` that translates spawn failures into
 * structured tool results.
 *
 * Spawn ENOENT masquerade: a dead working directory (deleted worktree) surfaces
 * as `spawn /bin/sh ENOENT` — naming the shell, not the dir. Translate
 * post-failure via statSync (error path only — no TOCTOU). When no explicit
 * cwd was passed, spawn inherited the process cwd; process.cwd() itself throws
 * when that directory has been deleted, which is the same masquerade.
 */
export function attachErrorHandler(params: AttachErrorHandlerParams): void {
  const { proc, context, cwd, startedAt, settle } = params;

  proc.on('error', (err) => {
    const effectiveCwd = context?.resolveBase ?? cwd;
    let message: string;
    if (effectiveCwd === undefined && isSpawnEnoent(err)) {
      try {
        const inherited = process.cwd();
        message = describeSpawnCwdError(err, inherited);
      } catch {
        message = `working directory does not exist (process cwd deleted — deleted worktree?) — underlying: ${err.message}`;
      }
    } else {
      message = describeSpawnCwdError(err, effectiveCwd);
    }
    settle({ content: `Failed to execute: ${message}`, isError: true, durationMs: Date.now() - startedAt });
  });
}
