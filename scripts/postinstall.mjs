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

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
 * NOTE: the install flow no longer calls this. SIGTERM'ing a manually-started
 * bot left it dead with nothing to relaunch it (postinstall cannot reliably
 * spawn a detached long-lived process). The main block now NOTIFIES instead
 * (see isManualBotRunning). Retained as a tested, reusable utility.
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

/**
 * Read-only probe: is a *manually-started* telegram bot still alive? Only the
 * `afk telegram start` path records a child PID in bot.pid; a launchd-supervised
 * bot does NOT (launchd owns its PID — see src/service/launchd/paths.ts), so a
 * non-null result here always means a manual bot — exactly the instance the
 * launchd kickstart below cannot reach.
 *
 * Unlike the manager's isRunning(), this does NOT unlink a stale PID file:
 * postinstall must not mutate runtime state. Returns the live PID, or null when
 * the file is missing/malformed or the process is gone.
 *
 * @param {string} pidFilePath
 * @param {function} [probeFn]   - Injectable existence probe; defaults to process.kill.
 * @returns {number|null}
 */
export function isManualBotRunning(pidFilePath, probeFn = process.kill) {
  try {
    const raw = readFileSync(pidFilePath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    probeFn(pid, 0); // signal 0 = existence check; delivers no signal
    return pid;
  } catch {
    // File missing, non-numeric PID, ESRCH, EPERM — treat as not-running.
    return null;
  }
}

/**
 * Restart installed AFK launchd services so they pick up the just-installed
 * code. A long-running Node process keeps the OLD module graph in memory after
 * `npm install -g` overwrites the files on disk; only a restart swaps it.
 * `launchctl kickstart -k` kills and relaunches the job against the (now
 * updated) on-disk entrypoint — ProgramArguments are unchanged, only file
 * contents, so no plist reload is needed.
 *
 * Fail-open and best-effort: a service whose plist is absent is skipped (never
 * installed as a service); a launchctl error (job not loaded, launchctl wedged)
 * is swallowed so the install never fails. macOS only — the caller gates on
 * platform; elsewhere ~/Library/LaunchAgents won't exist so nothing restarts.
 *
 * Label / path / domain conventions mirror src/service/launchd/paths.ts
 * (labelFor → `com.afk.<name>`, plist under ~/Library/LaunchAgents, guiDomain →
 * `gui/<uid>`). Kept in sync by hand — this plain .mjs cannot import the
 * compiled TS helpers.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.home]      - Home dir; defaults to os.homedir().
 * @param {number}   [opts.uid]       - Numeric uid; defaults to process.getuid().
 * @param {string[]} [opts.labels]    - launchd labels to consider.
 * @param {function} [opts.existsFn]  - Injectable plist existence check.
 * @param {function} [opts.execFn]    - Injectable launchctl runner; receives the argv array.
 * @returns {string[]} labels that were successfully restarted.
 */
export function restartLaunchdServices(opts = {}) {
  const home = opts.home ?? homedir();
  const uid =
    opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 501);
  const labels = opts.labels ?? ['com.afk.telegram', 'com.afk.daemon'];
  const existsFn = opts.existsFn ?? existsSync;
  const execFn =
    opts.execFn ??
    ((argv) =>
      execFileSync('launchctl', argv, {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 8000,
      }));

  const restarted = [];
  for (const label of labels) {
    const plist = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    if (!existsFn(plist)) continue; // not installed as a service
    try {
      execFn(['kickstart', '-k', `gui/${uid}/${label}`]);
      restarted.push(label);
    } catch {
      // Job not loaded, or launchctl errored — skip; install must not fail.
    }
  }
  return restarted;
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

  // Bring already-running AFK services onto the just-installed code. A long
  // running process keeps the old module graph in memory after npm overwrites
  // the files on disk — only a restart swaps it.
  //
  // 1. launchd-supervised services (telegram + daemon): restart in place so
  //    they re-exec the new entrypoint. macOS only; fail-open.
  if (process.platform === 'darwin') {
    try {
      const restarted = restartLaunchdServices();
      if (restarted.length > 0) {
        const names = restarted.map((l) => l.replace(/^com\.afk\./, '')).join(', ');
        process.stdout.write(
          `\n↻ Restarted AFK service(s) onto the new version: ${names}\n`,
        );
      }
    } catch {
      // restartLaunchdServices is already fail-open; belt-and-suspenders.
    }
  }

  // 2. A manually-started telegram bot (`afk telegram start`) is not supervised
  //    by launchd, so we cannot relaunch it safely from an npm lifecycle script.
  //    Earlier versions SIGTERM'd it here, which left it dead with nothing to
  //    bring it back. Notify instead so the user can restart it deliberately.
  try {
    const afkHome = process.env['AFK_HOME'] ?? join(homedir(), '.afk');
    const botPidPath = join(afkHome, 'state', 'telegram', 'bot.pid');
    const manualPid = isManualBotRunning(botPidPath);
    if (manualPid !== null) {
      process.stdout.write(
        `\n⚠ A manually-started telegram bot (PID ${manualPid}) is still running the previous version.\n` +
          `  Restart it to apply the update:  afk telegram restart\n`,
      );
    }
  } catch {
    // Best-effort notice — never block the install.
  }

  process.exit(0);
}
