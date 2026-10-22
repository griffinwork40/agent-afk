/**
 * Process plumbing for `LspClient` (#4272, review findings C-1 / S-1):
 * shell-free spawn-argument construction and whole-tree kill with a bounded
 * wait for exit.
 *
 * Invariant: no LSP server is ever spawned through a shell. On win32 npm
 * installs `.cmd` shims, which `spawn` cannot run without `shell: true`
 * (and cmd.exe would then interpret the command line and own the pid, so a
 * kill reached only the wrapper). Instead the shim is parsed for its JS
 * entry point and run as `process.execPath <entry> ...args`, so the spawned
 * pid IS the server. A `.cmd`/`.bat` that is not a recognisable npm shim is
 * refused rather than handed to cmd.exe.
 *
 * Invariant: on POSIX the server leads its own process group (`detached`),
 * so a kill takes down helpers it spawned (e.g. tsserver under
 * typescript-language-server). On win32 `taskkill /T` walks the tree.
 *
 * @module agent/lsp/client-process
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { killProcessGroup, killProcessGroupAndWait } from '../../utils/kill-process-group.js';
import { findOnPath } from './registry.js';

/** Executable + argv for `spawn` (never run through a shell). */
export interface SpawnCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface SpawnCommandDeps {
  readonly platform?: NodeJS.Platform;
  /** Node binary used to run a shim's JS entry. Default `process.execPath`. */
  readonly execPath?: string;
  /** Read a shim file as text. Default `readFileSync(p, 'utf8')`. */
  readonly readFile?: (p: string) => string;
  /** Resolve a bare command name on PATH (win32). Default `findOnPath`. */
  readonly lookup?: (bin: string, platform: NodeJS.Platform) => string | undefined;
}

/** npm cmd-shim target: `"%dp0%\..\pkg\bin\cli.js" %*` (older: `%~dp0\`). */
const SHIM_TARGET = /"%~?dp0%?\\([^"%]+)"\s*%\*/i;
const SCRIPT_EXT = /\.(?:js|mjs|cjs)$/i;
const BATCH_EXT = /\.(?:cmd|bat)$/i;

/**
 * Build the spawn command for `command args`. POSIX: unchanged. win32: an
 * npm `.cmd`/`.bat` shim is resolved to `execPath <js entry> ...args`; any
 * other command (`.exe`, bare name) is passed through unchanged. Throws when
 * a batch file is not a parseable npm shim (never falls back to a shell).
 */
export function buildSpawnCommand(
  command: string,
  args: readonly string[],
  deps: SpawnCommandDeps = {},
): SpawnCommand {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return { file: command, args: [...args] };
  // A bare PATH name (registry source 'path') may be a .cmd shim that spawn()
  // cannot find without a shell: resolve it to an absolute path first.
  const bare = !/[\\/]/.test(command) && path.win32.extname(command) === '';
  const resolved = bare ? (deps.lookup ?? findOnPath)(command, platform) ?? command : command;
  if (!BATCH_EXT.test(resolved)) return { file: resolved, args: [...args] };
  const text = (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(resolved);
  const rel = SHIM_TARGET.exec(text)?.[1];
  if (!rel || !SCRIPT_EXT.test(rel)) {
    throw new Error(`Refusing to run ${path.win32.basename(resolved)} through a shell: not an npm shim`);
  }
  const shimDir = path.win32.dirname(resolved);
  const entry = path.win32.join(shimDir, rel);
  // Security (F3): assert the resolved entry stays inside the node_modules
  // tree (parent of .bin). A crafted shim with many `..` components could
  // otherwise escape the npm install prefix and reach arbitrary paths.
  // Legitimate npm shims use exactly one `..` step: `.bin\..\pkg\cli.js`.
  // We normalise and check containment against the node_modules directory
  // (dirname of .bin), which is the broadest legitimate boundary.
  const allowedRoot = path.win32.normalize(path.win32.dirname(shimDir)) + path.win32.sep;
  const normalEntry = path.win32.normalize(entry);
  if (!normalEntry.startsWith(allowedRoot)) {
    throw new Error(
      `Refusing to run ${path.win32.basename(resolved)}: shim entry escapes package directory (path traversal)`,
    );
  }
  return { file: deps.execPath ?? process.execPath, args: [entry, ...args] };
}

/** Spawn the server for `command args` in `root` (stdio piped, stderr ignored). */
export function spawnServer(command: string, args: readonly string[], root: string): ChildProcess {
  const cmd = buildSpawnCommand(command, args);
  return spawn(cmd.file, [...cmd.args], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
}

/** Promise that settles once `proc` has exited (or failed to spawn). */
export function exitPromise(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.once('error', () => resolve());
  });
}

/**
 * Kill `proc` and its descendants (POSIX: SIGKILL to the process group;
 * win32: `taskkill /F /T`). Never throws.
 *
 * Invariant: on win32 the direct child is NOT killed here — taskkill /T
 * walks the tree from the live root, so killing the root first would orphan
 * its children. `forceKillRoot` is the fallback once the bounded wait fails.
 */
export function killServerTree(proc: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  if (hasTerminated(proc)) return;
  const pid = proc.pid;
  if (pid !== undefined && pid > 0) killProcessGroup(pid, 'SIGKILL', { platform });
  if (platform !== 'win32') forceKillRoot(proc);
}

/**
 * Invariant: after recorded termination a numeric PID may name an unrelated
 * process. Apply the guard on POSIX too: surviving members reserve the pgid,
 * but we cannot prove that any remain, so an empty group could be reused.
 */
function hasTerminated(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** Await the tree walk before giving an EOF-exiting root permission to exit. */
export async function killServerTreeAndWait(
  proc: ChildProcess,
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (hasTerminated(proc)) return;
  const pid = proc.pid;
  if (pid !== undefined && pid > 0) {
    await killProcessGroupAndWait(pid, 'SIGKILL', { platform }, timeoutMs);
  }
  if (platform !== 'win32') forceKillRoot(proc);
}

/** Kill only the direct child. Never throws. */
export function forceKillRoot(proc: ChildProcess): void {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

/** Resolve after `exited` settles or `timeoutMs` elapses, whichever is first. */
export async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([exited, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
