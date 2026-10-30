/**
 * Spawn-options builder for the bash handler.
 *
 * Assembles the `spawn` call arguments from per-session context (cwd, env,
 * shell resolution, platform) so `createBashHandler` stays under the 200-line
 * function ceiling. All inputs are explicit parameters — no module-scope
 * singletons, no `process.env` direct reads.
 *
 * When `AFK_BASH_SANDBOX` is set, the command is wrapped in an OS-level
 * sandbox via {@link buildSandboxedCommand} before spawning. Fail-closed:
 * if the sandbox mechanism is unavailable, spawn throws rather than falling
 * back to an unsandboxed run.
 *
 * @module agent/tools/handlers/bash.spawn
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { ToolHandlerContext } from '../types.js';
import { buildChildEnv } from './bash-env-scrub.js';
import { resolveShell } from '../../../utils/resolve-shell.js';
import { parseSandboxPolicy, buildSandboxedCommand } from './bash-sandbox.js';

/**
 * Assemble `spawn` options and launch the child process.
 *
 * When `AFK_BASH_SANDBOX` is configured, the command is wrapped in an
 * OS-level sandbox before spawning. The function throws (fail-closed) if
 * the requested sandbox is unavailable on the current platform.
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
  const isWin32 = process.platform === 'win32';

  // Effective cwd priority:
  // 1. context?.resolveBase — permission-system anchor (from dispatcher)
  // 2. factory-level cwd   — session worktree isolation (from createBashHandler)
  // Falls back to process.cwd() implicitly when both are undefined.
  const effectiveCwd = context?.resolveBase ?? cwd;

  const spawnBaseOpts = {
    // detached: true places the shell in its own process group (PGID = proc.pid).
    // Combined with process.kill(-proc.pid, 'SIGKILL') below, this lets us kill
    // the entire group atomically — including backgrounded grandchildren — so no
    // orphan processes leak after a timeout or abort (process-group orphan fix).
    // On Windows, detached does not create a process group so we disable it.
    detached: !isWin32,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
    // Always scrub episode-revealing vars (issue #2425) regardless of
    // whether context.env is set. buildChildEnv also materialises the
    // session's private TMPDIR.
    env: buildChildEnv(context?.env),
  };

  // ── Sandbox path ───────────────────────────────────────────────────────
  // When AFK_BASH_SANDBOX is set, wrap the command in an OS-level sandbox.
  // buildSandboxedCommand throws (fail-closed) if the mechanism is unavailable.
  const sandboxPolicy = parseSandboxPolicy();
  if (sandboxPolicy !== undefined && sandboxPolicy !== 'off') {
    const sandboxed = buildSandboxedCommand(command, sandboxPolicy, effectiveCwd);
    // sandboxed.shell is the sandbox binary (sandbox-exec / bwrap).
    // sandboxed.args are the pre-command arguments.
    // sandboxed.command is the original shell command string, passed last.
    const proc = spawn(
      sandboxed.shell,
      [...sandboxed.args, sandboxed.command],
      spawnBaseOpts,
    );
    proc.unref();
    return proc;
  }

  // ── Unsandboxed path (default) ─────────────────────────────────────────
  // Cross-platform shell: on POSIX `resolveShell()` returns `{ shell: true }`
  // so Node picks `/bin/sh` as before. On Windows it returns a path to Git
  // Bash or PowerShell with the appropriate `-c`/`-Command` prefix arg so
  // POSIX-style commands the model emits actually work (cmd.exe would not).
  const shellResolution = resolveShell();

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
