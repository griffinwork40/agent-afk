/**
 * Telegram bot process manager.
 *
 * Owns the bot's daemonized lifecycle: start (spawn detached, write PID),
 * stop (SIGTERM with fallback to SIGKILL), status (introspect), restart.
 * State (PID file, log file) lives under `~/.afk/state/telegram/` to match
 * the user-scope path convention documented in `src/paths.ts` — not in the
 * project tree, which was the legacy bash script's gotcha.
 *
 * Pure functions; the CLI command thin-wraps these. No chalk / console
 * formatting here — that's the command layer's job. This module returns
 * structured results so tests and future surfaces (e.g. a TUI status panel)
 * can render them however they like.
 *
 * @module telegram/manager
 */

import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, openSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAfkStateDir, getLogsDir } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolved paths for runtime state. */
export interface ManagerPaths {
  pidFile: string;
  logFile: string;
}

/** Resolve runtime paths. Created lazily on first write. */
export function getManagerPaths(): ManagerPaths {
  const stateDir = join(getAfkStateDir(), 'telegram');
  return {
    pidFile: join(stateDir, 'bot.pid'),
    logFile: join(getLogsDir(), 'telegram.log'),
  };
}

/** Lifecycle status returned by `status()`. */
export interface BotStatus {
  running: boolean;
  pid?: number;
  uptimeSec?: number;
  memoryMb?: number;
  logTail?: string[];
  pidFile: string;
  logFile: string;
}

/** Successful start result. */
export interface StartResult {
  kind: 'started';
  pid: number;
  logFile: string;
}

/** Recoverable start failure (already running, exited immediately, etc). */
export interface StartFailure {
  kind: 'already-running' | 'exited-immediately' | 'spawn-failed';
  pid?: number;
  logTail?: string[];
  message: string;
}

/** Stop result. */
export interface StopResult {
  kind: 'stopped' | 'not-running' | 'force-killed';
  pid?: number;
}

/**
 * Check whether the recorded PID is still alive. Cleans up stale PID files
 * automatically (process died without removing its own marker).
 */
export function isRunning(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, 'utf-8').trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    unlinkSync(pidFile);
    return null;
  }
  try {
    // signal 0 = existence probe, no signal delivered
    process.kill(pid, 0);
    return pid;
  } catch {
    // ESRCH = stale PID file
    unlinkSync(pidFile);
    return null;
  }
}

/** Resolve the path to the compiled bot entrypoint.
 *
 * Three layouts to handle (in priority order):
 *   1. Published bundle (scripts/build-dist.mjs): everything is flattened
 *      into dist/cli.mjs + dist/telegram.mjs, so this module's __dirname
 *      resolves to dist/ and the entry is a *sibling* — dist/telegram.mjs.
 *   2. tsc-only build (pnpm build): manager.js sits at dist/telegram/manager.js,
 *      entry is one directory up at dist/telegram.js.
 *   3. Dev / vitest (tsx): manager.ts sits at src/telegram/manager.ts,
 *      entry is one directory up at src/telegram.ts.
 *
 * Order matters: in a published install dist/telegram/ also exists (tsc
 * artifacts shipped alongside the bundle), but spawning the unbundled
 * dist/telegram.js would re-import unbundled deps that the published
 * package no longer carries — so the sibling .mjs *must* win.
 */
export function resolveEntrypoint(
  searchDir: string = __dirname,
  existsCheck: (path: string) => boolean = existsSync,
): string {
  const candidates = [
    join(searchDir, 'telegram.mjs'), // bundled layout (sibling of cli.mjs)
    join(searchDir, '..', 'telegram.js'), // tsc layout
    join(searchDir, '..', 'telegram.ts'), // dev / vitest
  ];
  for (const candidate of candidates) {
    if (existsCheck(candidate)) return candidate;
  }
  throw new Error(
    `Telegram entrypoint not found. Searched: ${candidates.join(', ')}`,
  );
}

/**
 * Spawn the bot as a detached background process. Writes PID, redirects
 * stdout/stderr to the log file, and verifies the child is still alive
 * after a short settle window before declaring success.
 *
 * Returns a discriminated union so the CLI can render the right message
 * without inspecting internal state.
 */
export async function start(): Promise<StartResult | StartFailure> {
  const { pidFile, logFile } = getManagerPaths();
  const existingPid = isRunning(pidFile);
  if (existingPid !== null) {
    return {
      kind: 'already-running',
      pid: existingPid,
      message: `Bot already running (PID ${existingPid}). Use 'afk telegram stop' first.`,
    };
  }

  // Ensure dirs exist (user-scope; OK to mkdirp).
  mkdirSync(dirname(pidFile), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });

  const entrypoint = resolveEntrypoint();
  // Append-mode FDs so the log is preserved across restarts.
  const out = openSync(logFile, 'a');
  const err = openSync(logFile, 'a');

  let child;
  try {
    child = spawn(process.execPath, [entrypoint], {
      detached: true,
      stdio: ['ignore', out, err],
      env: process.env,
    });
  } catch (error) {
    return {
      kind: 'spawn-failed',
      message: `Failed to spawn bot: ${(error as Error).message}`,
    };
  }

  if (child.pid === undefined) {
    return {
      kind: 'spawn-failed',
      message: 'Spawned child has no PID',
    };
  }

  writeFileSync(pidFile, String(child.pid), { mode: 0o644 });
  child.unref();

  // Settle window: if the bot's auth/env validation fails it exits within
  // ~100ms. Give it 1.5s, then check the PID is still alive.
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));

  if (isRunning(pidFile) === null) {
    return {
      kind: 'exited-immediately',
      logTail: tailLog(logFile, 20),
      message: 'Bot exited immediately after launch. Check the log for details.',
    };
  }

  return { kind: 'started', pid: child.pid, logFile };
}

/**
 * Stop the bot. Sends SIGTERM, waits up to 5s for graceful exit, then
 * escalates to SIGKILL. Always cleans up the PID file.
 */
export async function stop(): Promise<StopResult> {
  const { pidFile } = getManagerPaths();
  const pid = isRunning(pidFile);
  if (pid === null) return { kind: 'not-running' };

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already dead between the existence check and signal — fall through
    if (existsSync(pidFile)) unlinkSync(pidFile);
    return { kind: 'stopped', pid };
  }

  // Up to 5s graceful window.
  for (let i = 0; i < 50; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (isRunning(pidFile) === null) {
      return { kind: 'stopped', pid };
    }
  }

  // Escalate.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  if (existsSync(pidFile)) unlinkSync(pidFile);
  return { kind: 'force-killed', pid };
}

/** Snapshot of the bot's runtime state. Safe to call from anywhere. */
export function status(): BotStatus {
  const { pidFile, logFile } = getManagerPaths();
  const pid = isRunning(pidFile);

  const base: BotStatus = {
    running: pid !== null,
    pidFile,
    logFile,
  };

  if (pid === null) {
    return { ...base, logTail: tailLog(logFile, 10) };
  }

  const meta = readProcessMeta(pid);
  return {
    ...base,
    pid,
    ...meta,
    logTail: tailLog(logFile, 10),
  };
}

/** Tail the last N lines of the log file. Returns [] if missing. */
function tailLog(logFile: string, n: number): string[] {
  if (!existsSync(logFile)) return [];
  try {
    const contents = readFileSync(logFile, 'utf-8');
    const lines = contents.split('\n');
    // Drop trailing empty line from final newline.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Read uptime + RSS from `ps`. Returns empty if `ps` isn't available or the
 * process disappeared between the existence probe and the metadata read.
 */
function readProcessMeta(pid: number): { uptimeSec?: number; memoryMb?: number } {
  try {
    // Cross-platform `ps` output varies; use `/proc` on linux, `ps -p` on darwin.
    if (process.platform === 'linux') {
      const procStat = `/proc/${pid}/stat`;
      if (!existsSync(procStat)) return {};
      const statContent = readFileSync(procStat, 'utf-8');
      // Field 22 = starttime in clock ticks since boot
      const fields = statContent.split(' ');
      const startTicks = Number.parseInt(fields[21] ?? '0', 10);
      const clockTicks = 100; // POSIX default; near-universal on Linux
      const bootStat = statSync('/proc/1');
      const bootSec = bootStat.mtimeMs / 1000;
      const startSec = bootSec + startTicks / clockTicks;
      const uptimeSec = Math.floor(Date.now() / 1000 - startSec);

      const statusContent = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const rssMatch = statusContent.match(/VmRSS:\s+(\d+)\s+kB/);
      const memoryMb = rssMatch ? Math.round((Number.parseInt(rssMatch[1] ?? '0', 10)) / 1024) : undefined;
      return { uptimeSec, memoryMb };
    }

    if (process.platform === 'darwin') {
      // Lazy `ps` shell-out — narrow and well-contained.
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'etime=,rss='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      // etime format: [[dd-]hh:]mm:ss
      const [etime, rssKb] = out.split(/\s+/);
      return {
        uptimeSec: parseEtime(etime ?? ''),
        memoryMb: rssKb ? Math.round(Number.parseInt(rssKb, 10) / 1024) : undefined,
      };
    }
  } catch {
    /* ps unavailable or process disappeared */
  }
  return {};
}

/** Parse `ps -o etime` format into seconds. Exported for tests. */
export function parseEtime(etime: string): number | undefined {
  if (!etime) return undefined;
  // [[dd-]hh:]mm:ss
  const dashSplit = etime.split('-');
  let days = 0;
  let rest = etime;
  if (dashSplit.length === 2) {
    days = Number.parseInt(dashSplit[0] ?? '0', 10);
    rest = dashSplit[1] ?? '';
  }
  const parts = rest.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts as [number, number, number];
  else if (parts.length === 2) [m, s] = parts as [number, number];
  else if (parts.length === 1) [s] = parts as [number];
  else return undefined;
  return days * 86400 + h * 3600 + m * 60 + s;
}
