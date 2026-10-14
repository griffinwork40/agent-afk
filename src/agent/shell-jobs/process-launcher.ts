/**
 * Spawn and supervise one model-started background process.
 *
 * Invariant: the supervised unit is the LEADER process (the shell spawned for
 * the command) and its process group. On POSIX the leader is spawned with
 * `detached: true`, so its PGID equals its PID and `killProcessGroup` reaches
 * every descendant that did not deliberately leave the group (`setsid`,
 * daemonizing double-forks escape; that is a documented limit).
 *
 * Settle contract (exactly once):
 *   1. Spawn failure (`'error'` before exit) settles with `spawnError`.
 *   2. Leader exit starts a `closeGraceMs` window. If stdout/stderr close in
 *      that window, the job settles with the leader's exit code and signal.
 *   3. If the pipes are still held open when the window ends, some group
 *      member outlived the leader. The group is sent SIGTERM, then SIGKILL
 *      after `reapGraceMs`, the pipes are destroyed, and the job settles with
 *      `orphansReaped: true`. A run never leaves untracked survivors behind.
 *
 * PGID safety: the group is only signalled while the job is unsettled. Before
 * settle, either the leader is alive or a group member is still holding the
 * pipe, and POSIX never hands out a PID equal to a PGID that is still in use,
 * so the signal cannot reach an unrelated process group. (A pipe held only by
 * a process that left the group via `setsid` is the narrow exception; that
 * escapee is a documented limit.) On Windows there is no process group: the
 * tree kill targets the leader PID, which is free for reuse once the leader
 * exits, so after leader exit Windows never signals and only releases pipes.
 *
 * @module agent/shell-jobs/process-launcher
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessGroup } from '../../utils/kill-process-group.js';
import { resolveShell } from '../../utils/resolve-shell.js';
import { errorMessage } from '../../utils/errors.js';
import type { ProcessLogSink } from './process-log-sink.js';

export interface ProcessExit {
  /** Leader exit code; null when the leader died by signal or never spawned. */
  exitCode: number | null;
  /** Signal that ended the leader, if any. */
  signal: string | null;
  /** True when group members outlived the leader and were killed. */
  orphansReaped: boolean;
  /** Set when the shell could not be spawned at all. */
  spawnError?: string;
}

export interface LaunchOptions {
  command: string;
  cwd?: string | undefined;
  env: NodeJS.ProcessEnv;
  sink: ProcessLogSink;
  /** Wait after leader exit for the pipes to close. Default 2000 ms. */
  closeGraceMs?: number;
  /** Wait between SIGTERM and SIGKILL when reaping survivors. Default 2000 ms. */
  reapGraceMs?: number;
}

export interface LaunchedProcess {
  readonly pid: number | undefined;
  /** Resolves once with the final exit record. Never rejects. */
  readonly exited: Promise<ProcessExit>;
  /** True until the job settles. */
  isLive(): boolean;
  /** True once the leader process has exited (the job may still be settling). */
  leaderExited(): boolean;
  /** Signal the whole group. No-op once settled (see PGID safety). */
  signalGroup(signal: NodeJS.Signals): void;
}

const DEFAULT_CLOSE_GRACE_MS = 2_000;
const DEFAULT_REAP_GRACE_MS = 2_000;

function spawnLeader(opts: LaunchOptions): ChildProcess {
  const shellResolution = resolveShell();
  const base = {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    env: opts.env,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  };
  return shellResolution.shell === true
    ? spawn(opts.command, { shell: true, ...base })
    : spawn(shellResolution.shell, [...(shellResolution.args ?? []), opts.command], base);
}

export function launchProcess(opts: LaunchOptions): LaunchedProcess {
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const reapGraceMs = opts.reapGraceMs ?? DEFAULT_REAP_GRACE_MS;
  let settled = false;
  let resolveExit!: (e: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((r) => { resolveExit = r; });
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  let proc: ChildProcess;
  try {
    proc = spawnLeader(opts);
  } catch (err) {
    opts.sink.close();
    settled = true;
    resolveExit({ exitCode: null, signal: null, orphansReaped: false, spawnError: errorMessage(err) });
    return { pid: undefined, exited, isLive: () => false, leaderExited: () => true, signalGroup: () => {} };
  }
  proc.unref();
  const pid = proc.pid;

  function settle(e: ProcessExit): void {
    if (settled) return;
    settled = true;
    for (const t of timers) clearTimeout(t);
    opts.sink.close();
    resolveExit(e);
  }

  let leaderExit: { code: number | null; signal: string | null } | undefined;
  const isWin32 = process.platform === 'win32';

  function signalGroup(signal: NodeJS.Signals): void {
    if (settled || pid === undefined) return;
    if (isWin32 && leaderExit !== undefined) return; // freed PID: see header
    killProcessGroup(pid, signal);
  }

  proc.stdout?.on('data', (c: Buffer) => opts.sink.write(c, 'stdout'));
  proc.stderr?.on('data', (c: Buffer) => opts.sink.write(c, 'stderr'));

  let reaping = false;
  proc.once('error', (err) => {
    if (leaderExit === undefined) {
      settle({ exitCode: null, signal: null, orphansReaped: false, spawnError: errorMessage(err) });
    }
  });
  proc.once('exit', (code, signal) => {
    leaderExit = { code, signal };
    // Orphan reap: pipes still open after the grace window means a group
    // member outlived the leader. TERM, then KILL, then release the pipes.
    timers.push(setTimeout(() => {
      reaping = true;
      signalGroup('SIGTERM');
      timers.push(setTimeout(() => {
        signalGroup('SIGKILL');
        try { proc.stdout?.destroy(); } catch { /* best effort */ }
        try { proc.stderr?.destroy(); } catch { /* best effort */ }
        settle({ exitCode: code, signal, orphansReaped: !isWin32 });
      }, reapGraceMs));
    }, closeGraceMs));
  });
  proc.once('close', (code, signal) => {
    // Invariant: on POSIX, pipe closure after the leader exits is not proof
    // that the process group is gone — an output-redirected descendant
    // (`sleep 300 >/dev/null 2>&1 &`) closes the leader's pipe ends while
    // keeping its own separate file descriptors, so it is still alive.  Probe
    // the group; if alive, reap before settling so no descendant escapes
    // max-runtime, cancel, or session teardown.
    //
    // Contract: settle is called exactly once — the reaping branch below calls
    // settle itself, so early return is required to avoid a double call.
    //
    // History: without this probe, the 'close' fired immediately after the
    // leader exited (because the leader's own pipe ends closed), the orphan-
    // reap timer was cancelled, and output-redirected descendants escaped
    // every supervision path.
    const leader = leaderExit; // const: keeps the narrowing inside the timer closure
    if (leader !== undefined && !reaping && !isWin32 && pid !== undefined) {
      let groupStillAlive = false;
      try { process.kill(-pid, 0); groupStillAlive = true; } catch { /* ESRCH: group gone */ }
      if (groupStillAlive) {
        // Group has survivors — run the same TERM → reapGraceMs → KILL reap
        // that the closeGraceMs timer would have triggered.  Clear the grace
        // timer first so it does not fire a second reap after we've settled.
        for (const t of timers) clearTimeout(t);
        timers.length = 0;
        reaping = true;
        signalGroup('SIGTERM');
        const killTimer = setTimeout(() => {
          signalGroup('SIGKILL');
          try { proc.stdout?.destroy(); } catch { /* best effort */ }
          try { proc.stderr?.destroy(); } catch { /* best effort */ }
          settle({ exitCode: leader.code, signal: leader.signal, orphansReaped: true });
        }, reapGraceMs);
        timers.push(killTimer);
        return;
      }
    }
    // Windows path, or group already gone, or leader still running (leaderExit
    // undefined, should not happen here but safe to handle).
    const e = leaderExit ?? { code, signal };
    settle({ exitCode: e.code, signal: e.signal, orphansReaped: reaping });
  });

  return { pid, exited, isLive: () => !settled, leaderExited: () => leaderExit !== undefined, signalGroup };
}

/**
 * Graceful stop: SIGTERM the group, then SIGKILL after `graceMs` if the job
 * has not settled. Safe to call on an already-settled job (no signal sent).
 */
export function terminateWithGrace(launched: LaunchedProcess, graceMs: number): void {
  if (!launched.isLive()) return;
  launched.signalGroup('SIGTERM');
  const t = setTimeout(() => launched.signalGroup('SIGKILL'), graceMs);
  t.unref();
  void launched.exited.then(() => clearTimeout(t));
}
