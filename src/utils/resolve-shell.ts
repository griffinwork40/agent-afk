/**
 * Cross-platform shell resolver for the bash tool.
 *
 * The bash tool is named "bash" and the system prompt instructs the model to
 * emit POSIX shell commands. On POSIX (Linux/macOS) `spawn(cmd, { shell: true })`
 * correctly routes through `/bin/sh`. On Windows, Node resolves `shell: true` to
 * `cmd.exe` via `%ComSpec%`, which cannot interpret POSIX commands.
 *
 * This module resolves the best available POSIX-compatible shell on Windows:
 *   1. Git Bash (preferred — full POSIX compatibility)
 *   2. PowerShell (fallback — better than cmd.exe, partial POSIX support)
 *
 * On POSIX platforms the resolver is a no-op: it returns `{ shell: true }` so
 * Node's own shell-resolution logic runs unchanged.
 *
 * @module utils/resolve-shell
 */

import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/** Return type for {@link resolveShell}. */
export interface ShellResolution {
  /** The shell executable, or `true` to let Node pick the platform default. */
  shell: string | true;
  /** Arguments to pass to the shell BEFORE the command string (e.g. `['-c']`). */
  args?: string[];
}

/** Well-known Git Bash installation paths on Windows. */
const GIT_BASH_PATHS: readonly string[] = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

/**
 * Locate `bash.exe` on Windows by checking `MSYSTEM`, known install paths,
 * and then every directory in `%PATH%`.
 *
 * @returns Absolute path to bash.exe, or `undefined` if not found.
 */
function findGitBashOnWindows(): string | undefined {
  // MSYSTEM is set by Git Bash environments — if it is present we are almost
  // certainly running inside Git Bash already, so `bash.exe` is on PATH.
  // Use win32.join so path construction is correct even when tests run on macOS.
  if (process.env['MSYSTEM'] !== undefined) {
    const pathDirs = (process.env['PATH'] ?? '').split(';');
    for (const dir of pathDirs) {
      const candidate = win32.join(dir, 'bash.exe');
      if (existsSync(candidate)) return candidate;
    }
  }

  // Check well-known Git for Windows install locations.
  for (const p of GIT_BASH_PATHS) {
    if (existsSync(p)) return p;
  }

  // Last resort: scan PATH.
  const pathDirs = (process.env['PATH'] ?? '').split(';');
  for (const dir of pathDirs) {
    const candidate = win32.join(dir, 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Resolve the best available shell for the current platform.
 *
 * - **POSIX** (Linux, macOS, etc.): returns `{ shell: true }` — Node picks
 *   `/bin/sh` as usual, behaviour is unchanged.
 * - **Windows with Git Bash**: returns `{ shell: '<path>', args: ['-c'] }`.
 * - **Windows without Git Bash**: returns `{ shell: 'powershell.exe', args: ['-Command'] }`
 *   as a fallback. `cmd.exe` is explicitly avoided: its 8 191-character command
 *   line limit and lack of POSIX compatibility make it unsuitable.
 */
export function resolveShell(): ShellResolution {
  if (process.platform !== 'win32') {
    return { shell: true };
  }

  const gitBash = findGitBashOnWindows();
  if (gitBash !== undefined) {
    return { shell: gitBash, args: ['-c'] };
  }

  return { shell: 'powershell.exe', args: ['-Command'] };
}

/**
 * Return a short human-readable description of the resolved shell.
 * Used by the bash tool description so the model knows which shell it is
 * targeting (important: POSIX instructions differ from PowerShell syntax).
 *
 * Examples: `"/bin/sh (POSIX)"`, `"Git Bash"`, `"PowerShell"`.
 */
export function shellDescription(): string {
  if (process.platform !== 'win32') {
    return '/bin/sh (POSIX)';
  }
  const gitBash = findGitBashOnWindows();
  return gitBash !== undefined ? 'Git Bash' : 'PowerShell';
}
