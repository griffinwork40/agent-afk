/**
 * Platform-aware browser opener.
 *
 * Swallows all errors — opening the browser is best-effort and must never
 * crash the CLI.
 *
 * @module insights/open
 */

import { execFile } from 'node:child_process';

/**
 * Open the given file path in the system default browser.
 * Uses `open` on macOS, `start` (via cmd) on Windows, `xdg-open` on Linux.
 * The spawned process is unref'd so the CLI can exit immediately.
 * All errors are swallowed.
 */
export function openInBrowser(filePath: string): void {
  // Invariant: the path is passed as a discrete argv element via execFile —
  // NEVER interpolated into a shell command string. A shell (exec/`sh -c`)
  // would re-parse metacharacters, so a path containing `$(...)`, backticks,
  // `;`, `|`, or `&` would execute arbitrary commands (RCE). execFile spawns
  // the binary directly with argv, so the OS never hands the path to a shell.
  const { bin, args } =
    process.platform === 'darwin'
      ? { bin: 'open', args: [filePath] }
      : process.platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '', filePath] }
        : { bin: 'xdg-open', args: [filePath] };

  try {
    // Providing a callback routes spawn failures there instead of throwing an
    // unhandled 'error' event; opening the browser is best-effort.
    const child = execFile(bin, args, () => {
      // Swallow — the report is already written; the browser open is optional.
    });
    child.unref();
  } catch {
    // Swallow synchronous spawn failures too.
  }
}
