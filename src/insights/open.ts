/**
 * Platform-aware browser opener.
 *
 * Swallows all errors — opening the browser is best-effort and must never
 * crash the CLI.
 *
 * @module insights/open
 */

import { exec } from 'node:child_process';

/**
 * Open the given file path in the system default browser.
 * Uses `open` on macOS, `start` on Windows, `xdg-open` on Linux.
 * The spawned process is unref'd so the CLI can exit immediately.
 * All errors are swallowed.
 */
export function openInBrowser(filePath: string): void {
  const escaped = filePath.replace(/"/g, '\\"');
  const cmd =
    process.platform === 'darwin'
      ? `open "${escaped}"`
      : process.platform === 'win32'
        ? `start "" "${escaped}"`
        : `xdg-open "${escaped}"`;

  try {
    exec(cmd).unref();
  } catch {
    // Opening the browser is best-effort; swallow all errors.
  }
}
