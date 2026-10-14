/**
 * Spawn-options builder for the bash handler.
 *
 * Assembles the `spawn` call arguments from per-session context (cwd, env,
 * shell resolution, platform) so `createBashHandler` stays under the 200-line
 * function ceiling. All inputs are explicit parameters — no module-scope
 * singletons, no `process.env` direct reads.
 *
 * @module agent/tools/handlers/bash.spawn
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { ToolHandlerContext } from '../types.js';
import { buildChildEnv } from './bash-env-scrub.js';
import { resolveShell } from '../../../utils/resolve-shell.js';

/**
 * Assemble `spawn` options and launch the child process.
 *
 * @param command   Raw shell command string from the model.
 * @param context   Optional per-call handler context (resolveBase, env, …).
 * @param cwd       Factory-level session cwd (worktree isolation anchor).
 * @returns The spawned {@link ChildProcess}.
 */
export function spawnBashProcess(
  command: string,
  context: ToolHandlerContext | undefined,
  cwd: string | undefined,
): ChildProcess {
  // Cross-platform shell: on POSIX `resolveShell()` returns `{ shell: true }`
  // so Node picks `/bin/sh` as before. On Windows it returns a path to Git
  // Bash or PowerShell with the appropriate `-c`/`-Command` prefix arg so
  // POSIX-style commands the model emits actually work (cmd.exe would not).
  const isWin32 = process.platform === 'win32';
  const shellResolution = resolveShell();

  const spawnBaseOpts = {
    // detached: true places the shell in its own process group (PGID = proc.pid).
    // Combined with process.kill(-proc.pid, 'SIGKILL') below, this lets us kill
    // the entire group atomically — including backgrounded grandchildren — so no
    // orphan processes leak after a timeout or abort (process-group orphan fix).
    // On Windows, detached does not create a process group so we disable it.
    detached: !isWin32,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    // Effective cwd priority:
    // 1. context?.resolveBase — permission-system anchor (from dispatcher)
    // 2. factory-level cwd   — session worktree isolation (from createBashHandler)
    // Falls back to process.cwd() implicitly when both are undefined.
    ...((context?.resolveBase ?? cwd) !== undefined
      ? { cwd: context?.resolveBase ?? cwd }
      : {}),
    // Always scrub episode-revealing vars (issue #2425) regardless of
    // whether context.env is set. buildChildEnv also materialises the
    // session's private TMPDIR.
    env: buildChildEnv(context?.env),
  };

  const proc =
    shellResolution.shell === true
      ? // POSIX: let Node pick /bin/sh via shell:true (existing behaviour)
        spawn(command, { shell: true, ...spawnBaseOpts })
      : // Windows: spawn the explicit shell with the command as a positional arg
        spawn(shellResolution.shell, [...(shellResolution.args ?? []), command], spawnBaseOpts);

  // unref() so Node's event loop doesn't hold open the process handle after
  // detach — belt-and-suspenders alongside detached: true.
  proc.unref();
  return proc;
}
