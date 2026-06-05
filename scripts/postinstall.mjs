#!/usr/bin/env node
/**
 * postinstall.mjs — Runs after `npm install` to check whether the npm bin
 * directory is on PATH and prints a remediation hint if not.
 *
 * Named export `detectPathGap` is a pure function for unit testing.
 * The main block is guarded by an import.meta.url check so this file can be
 * imported in tests without triggering the subprocess/print side-effects.
 *
 * Always exits 0 — never fails an install.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Pure function. Determines whether the npm bin directory is on PATH.
 *
 * @param {string} prefix   - Result of `npm config get prefix` (may have trailing slash)
 * @param {string} pathEnv  - The PATH string to check against (e.g. process.env.PATH)
 * @returns {{ onPath: boolean, binDir: string }}
 */
export function detectPathGap(prefix, pathEnv) {
  const normalizedPrefix = prefix.trim().replace(/\/$/, '');
  const binDir = `${normalizedPrefix}/bin`;
  const pathParts = (pathEnv ?? '').split(':').map((p) => p.replace(/\/$/, ''));
  const onPath = pathParts.includes(binDir);
  return { onPath, binDir };
}

/**
 * Pure function. Attempts to SIGTERM a daemon whose PID is written in the
 * given file. All errors are silently discarded — this is best-effort cleanup
 * that must never fail an install.
 *
 * @param {string} pidFilePath   - Full path to the PID file to read.
 * @param {function} [killFn]    - Injectable kill function; defaults to process.kill.
 *                                 Pass a stub in tests to avoid needing process.kill.
 */
export function killStaleDaemon(pidFilePath, killFn = process.kill) {
  try {
    const raw = readFileSync(pidFilePath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return;
    killFn(pid, 'SIGTERM');
  } catch {
    // File missing, non-numeric PID, ESRCH, EPERM, any other error — discard.
  }
}

// ─── Main block ─────────────────────────────────────────────────────────────
// Guard: only run when executed directly (not when imported by tests).
const isMain =
  typeof process !== 'undefined' &&
  typeof process.argv !== 'undefined' &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  // Only meaningful on macOS/Linux where PATH-based installs are common.
  if (process.platform === 'win32') {
    process.exit(0);
  }

  try {
    const prefix = execSync('npm config get prefix', {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const { onPath, binDir } = detectPathGap(prefix, process.env['PATH'] ?? '');

    if (!onPath) {
      const shell = process.env['SHELL'] ?? '';
      const rcFile = shell.includes('zsh')
        ? '~/.zshrc'
        : shell.includes('fish')
          ? '~/.config/fish/config.fish'
          : '~/.bashrc';

      const exportLine =
        shell.includes('fish')
          ? `fish_add_path ${binDir}`
          : `export PATH="${binDir}:$PATH"`;

      process.stdout.write(
        [
          '',
          '┌─────────────────────────────────────────────────────────────┐',
          '│  agent-afk: npm bin directory is not on your PATH          │',
          '│                                                             │',
          `│  Run this to fix it:                                        │`,
          `│    echo '${exportLine}' >> ${rcFile}`,
          '│    source ' + rcFile + '                                              │',
          '│                                                             │',
          '│  Or add this line to your shell profile manually:          │',
          `│    ${exportLine}`,
          '└─────────────────────────────────────────────────────────────┘',
          '',
        ].join('\n'),
      );
    }
  } catch {
    // execSync failed (npm not found, timeout, etc.) — silently ignore.
  }

  // Kill any stale daemon left over from the previous version so the
  // updated binary takes over on next launch rather than the old process
  // continuing to field requests.
  try {
    const afkHome = process.env['AFK_HOME'] ?? join(homedir(), '.afk');
    const pidFilePath = join(afkHome, 'state', 'telegram', 'bot.pid');
    killStaleDaemon(pidFilePath);
  } catch {
    // Belt-and-suspenders: killStaleDaemon already swallows all errors internally.
  }

  process.exit(0);
}
