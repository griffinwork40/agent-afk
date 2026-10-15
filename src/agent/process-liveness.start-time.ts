/**
 * Process START-TIME probing — the half of liveness `kill(pid, 0)` cannot do.
 *
 * `kill(pid, 0)` answers "does SOME process own this pid right now?". The OS
 * recycles pids, so a presence record whose owner died hours ago reads alive
 * again the moment an unrelated process inherits the number. Comparing the
 * start time recorded by the owner against the start time the OS reports for
 * the pid TODAY separates "same process" from "reused pid".
 *
 * Contract:
 *   - {@link probeProcessStartTimes} never throws and never rejects. Any pid
 *     whose start time cannot be determined maps to `undefined` ("unknown"),
 *     and callers must treat unknown as "keep", never as "dead".
 *   - Platform and process execution are injected so tests never depend on
 *     the host OS (POSIX-guard rule: no platform-skipped tests).
 *
 * Probes:
 *   - darwin / other BSD-ish: `ps -o pid= -o etime= -p <pid,pid,...>`. macOS
 *     `ps` has no `etimes`, so elapsed time is parsed from `etime`
 *     (`[[dd-]hh:]mm:ss`), which is locale-independent unlike `lstart`. One
 *     batched invocation covers every pid. A missing pid makes `ps` exit 1 but
 *     it still prints the rows it found, so stdout is parsed on failure too.
 *   - linux: `/proc/<pid>/stat` field 22 (`starttime`, clock ticks since boot).
 *     The raw tick count is reported as `startTicks` and is the identity
 *     callers should compare: it never changes for a running process. The
 *     epoch fallback adds `btime` from `/proc/stat`, but `btime` is recomputed
 *     from the CURRENT wall clock, so an NTP step or VM/WSL2 resume shifts it
 *     and would make every live process look restarted. Ticks/sec is assumed
 *     to be 100 (USER_HZ is 100 on every mainstream Linux ABI; reading the real
 *     value would need `getconf CLK_TCK`); only the epoch fallback uses it.
 *   - win32: unsupported, every pid is unknown.
 *
 * @module agent/process-liveness.start-time
 */

import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';

/**
 * What the OS reports about when a pid's current owner started.
 *
 *   - `startedAtMs`: wall-clock epoch ms. On darwin this is the kernel's own
 *     wall-clock start stamp (`now - etime`, and `etime` is itself `now -
 *     p_start`, so a clock step cancels out). On Linux it is derived from
 *     `btime`, which MOVES when the wall clock is stepped (NTP makestep,
 *     VM/WSL2 resume), so it is only a fallback there.
 *   - `startTicks`: Linux only. Raw `/proc/<pid>/stat` field 22, clock ticks
 *     since boot. Fixed for the life of the process and immune to wall-clock
 *     steps, so it is the preferred identity whenever both sides have it.
 */
export interface ProcessStartInfo {
  startedAtMs?: number;
  startTicks?: number;
}

/** Minimal process-exec seam: resolves stdout even when the command exits non-zero. */
export type StartTimeExec = (file: string, args: string[]) => Promise<{ stdout: string }>;

/** Injection seams for {@link probeProcessStartTimes}. */
export interface StartTimeProbeDeps {
  platform?: NodeJS.Platform;
  exec?: StartTimeExec;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
}

/** Linux USER_HZ. See the module header for why this is not read at runtime. */
export const LINUX_CLOCK_TICKS_PER_SEC = 100;

const PS_TIMEOUT_MS = 3000;

/** Default exec: `execFile` without a shell; stdout is surfaced even on non-zero exit. */
const defaultExec: StartTimeExec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: PS_TIMEOUT_MS, encoding: 'utf8' }, (_err, stdout) => {
      resolve({ stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });

/**
 * Parse a `ps` `etime` value (`mm:ss`, `hh:mm:ss`, `dd-hh:mm:ss`) to seconds.
 * Returns `undefined` for anything malformed.
 */
export function parseEtime(value: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!m) return undefined;
  const days = m[1] !== undefined ? Number(m[1]) : 0;
  const hours = m[2] !== undefined ? Number(m[2]) : 0;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  if (minutes >= 60 || seconds >= 60 || (m[1] !== undefined && hours >= 24)) return undefined;
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/**
 * Parse `ps -o pid= -o etime=` output into pid → start epoch ms, given `nowMs`.
 * Malformed lines are skipped.
 */
export function parsePsStartTimes(stdout: string, nowMs: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const pid = Number(parts[0]);
    const elapsed = parseEtime(parts[1] ?? '');
    if (!Number.isInteger(pid) || pid <= 0 || elapsed === undefined) continue;
    out.set(pid, nowMs - elapsed * 1000);
  }
  return out;
}

/**
 * Extract `starttime` (field 22, clock ticks since boot) from `/proc/<pid>/stat`.
 * Field 2 (`comm`) is parenthesised and may itself contain spaces and `)`, so
 * fields are split only after the LAST `)`.
 */
export function parseProcStatStartTicks(stat: string): number | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  // After ")" come fields 3.. ; field 22 is index 19 of that remainder.
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const raw = rest[19];
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/** Extract `btime` (boot epoch seconds) from `/proc/stat`. */
export function parseProcBootTime(procStat: string): number | undefined {
  const m = /^btime\s+(\d+)\s*$/m.exec(procStat);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

async function probeLinux(
  pids: readonly number[],
  read: (path: string) => Promise<string>,
): Promise<Map<number, ProcessStartInfo | undefined>> {
  const out = new Map<number, ProcessStartInfo | undefined>(pids.map((p) => [p, undefined]));
  // btime is optional: without it the step-immune tick identity still works.
  let bootSec: number | undefined;
  try {
    bootSec = parseProcBootTime(await read('/proc/stat'));
  } catch {
    bootSec = undefined;
  }
  for (const pid of pids) {
    try {
      const ticks = parseProcStatStartTicks(await read(`/proc/${pid}/stat`));
      if (ticks === undefined) continue;
      const info: ProcessStartInfo = { startTicks: ticks };
      if (bootSec !== undefined) {
        info.startedAtMs = Math.round((bootSec + ticks / LINUX_CLOCK_TICKS_PER_SEC) * 1000);
      }
      out.set(pid, info);
    } catch {
      // Unreadable or gone — unknown.
    }
  }
  return out;
}

/**
 * Best-effort OS start identity for each pid. Unknown → `undefined`.
 * Never throws. See the module header for per-platform probes.
 */
export async function probeProcessStartTimes(
  pids: readonly number[],
  deps: StartTimeProbeDeps = {},
): Promise<Map<number, ProcessStartInfo | undefined>> {
  const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  const out = new Map<number, ProcessStartInfo | undefined>(unique.map((p) => [p, undefined]));
  if (unique.length === 0) return out;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === 'win32') return out;
    if (platform === 'linux') return await probeLinux(unique, deps.readFile ?? ((p) => readFile(p, 'utf8')));
    const exec = deps.exec ?? defaultExec;
    const { stdout } = await exec('ps', ['-o', 'pid=', '-o', 'etime=', '-p', unique.join(',')]);
    const parsed = parsePsStartTimes(stdout, (deps.now ?? Date.now)());
    for (const pid of unique) {
      const startedAtMs = parsed.get(pid);
      out.set(pid, startedAtMs === undefined ? undefined : { startedAtMs });
    }
  } catch {
    // Never throw — every pid stays unknown.
  }
  return out;
}

// Invariant: captured at module load, not at call time. `process.uptime()` is
// derived from a monotonic clock that stops while the machine sleeps, so
// `Date.now() - uptime` drifts later by every suspend that happens between
// process start and the call. Presence is first written at the first `query()`,
// which in a REPL can be hours (and a laptop sleep) after launch. At import time
// uptime is a fraction of a second, so the drift window is negligible.
const OWN_PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

/** This process's own start time (epoch ms), in the same terms the probes report. */
export function ownProcessStartedAt(): number {
  return OWN_PROCESS_STARTED_AT;
}

/** Injection seams for {@link readOwnStartTicks}. */
export interface OwnStartTicksDeps {
  platform?: NodeJS.Platform;
  readFileSync?: (path: string) => string;
}

/**
 * This process's raw Linux `starttime` ticks from `/proc/self/stat`, or
 * `undefined` off Linux or on any read/parse failure. Never throws.
 */
export function readOwnStartTicks(deps: OwnStartTicksDeps = {}): number | undefined {
  if ((deps.platform ?? process.platform) !== 'linux') return undefined;
  try {
    const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
    return parseProcStatStartTicks(read('/proc/self/stat'));
  } catch {
    return undefined;
  }
}

// Lazily filled on first call; the value is fixed for the process lifetime.
let ownStartTicksMemo: { value: number | undefined } | null = null;

/**
 * This process's clock-step-immune start identity on Linux (see
 * {@link ProcessStartInfo.startTicks}); `undefined` elsewhere. Memoized.
 */
export function ownProcessStartTicks(): number | undefined {
  if (ownStartTicksMemo === null) ownStartTicksMemo = { value: readOwnStartTicks() };
  return ownStartTicksMemo.value;
}
