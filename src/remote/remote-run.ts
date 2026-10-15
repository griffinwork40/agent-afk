/**
 * Launch → follow → result orchestration for one remote afk run.
 *
 * Contract:
 *   - Launch is one ssh call. ssh exit 255 means the host is unreachable;
 *     the launch script's own exit codes name afk-not-found and a bad cwd.
 *   - Follow streams `out.ndjson` (afk `--format stream-json` events) and ends
 *     on the first `done` or `error` event, or when the remote process exits.
 *   - A dropped connection re-follows from the next unseen line. Consecutive
 *     failures without progress are capped at {@link MAX_RECONNECTS}; the run
 *     itself keeps going on the remote and the result says where it lives.
 *   - Abort (the caller's signal) kills the remote process, best-effort.
 *
 * @module remote/remote-run
 */

import {
  PID_MARKER,
  EXIT_MARKER,
  EXIT_AFK_NOT_FOUND,
  EXIT_BAD_CWD,
  buildLaunchScript,
  buildFollowScript,
  buildCancelScript,
  buildErrTailScript,
} from './remote-script.js';
import { SSH_CONNECT_FAILURE, type SshRunner } from './ssh-runner.js';
import { createEventCollector } from './remote-events.js';

export const MAX_RECONNECTS = 6;
const LAUNCH_TIMEOUT_MS = 60_000;
const CANCEL_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export interface RemoteRunRequest {
  target: string;
  prompt: string;
  runId: string;
  sessionId: string;
  cwd?: string;
  model?: string;
  resume?: string;
  afkPath?: string;
}

export type RemoteRunOutcome =
  | { kind: 'done'; message: string; pid: number; metadata?: Record<string, unknown> }
  | { kind: 'error'; reason: string; pid?: number; partial?: string }
  | { kind: 'aborted'; pid?: number }
  | { kind: 'lost'; reason: string; pid: number; partial?: string };

export interface RemoteRunDeps {
  runner: SshRunner;
  /** Injected for tests; resolves after `ms` or rejects-free on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function launch(
  req: RemoteRunRequest,
  runner: SshRunner,
  signal: AbortSignal,
): Promise<{ pid: number } | RemoteRunOutcome> {
  const script = buildLaunchScript(req);
  const res = await runner.exec(req.target, script, { stdin: req.prompt, signal, timeoutMs: LAUNCH_TIMEOUT_MS });
  if (signal.aborted) return { kind: 'aborted' };
  const stderr = res.stderr.trim();
  if (res.code === SSH_CONNECT_FAILURE) {
    return { kind: 'error', reason: `host unreachable (${req.target}): ${stderr || 'ssh exit 255'}` };
  }
  if (res.code === EXIT_AFK_NOT_FOUND) {
    return { kind: 'error', reason: `afk is not installed on ${req.target} (${stderr}). Install it there, or set "afkPath" for this host in hosts.json.` };
  }
  if (res.code === EXIT_BAD_CWD) return { kind: 'error', reason: `remote cwd does not exist on ${req.target}: ${stderr}` };
  const line = res.stdout.split('\n').find((l) => l.startsWith(PID_MARKER));
  const pid = line !== undefined ? Number(line.slice(PID_MARKER.length).trim()) : NaN;
  if (res.code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    return { kind: 'error', reason: `remote launch failed on ${req.target} (exit ${String(res.code)}): ${stderr || res.stdout.trim()}` };
  }
  return { pid };
}

/** Run one afk agent on a remote host and wait for its final answer. */
export async function runRemoteAgent(
  req: RemoteRunRequest,
  signal: AbortSignal,
  deps: RemoteRunDeps,
): Promise<RemoteRunOutcome> {
  const { runner } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const launched = await launch(req, runner, signal);
  if ('kind' in launched) return launched;
  const { pid } = launched;

  const events = createEventCollector();
  let linesSeen = 0;
  let failures = 0;
  let lastStderr = '';
  for (;;) {
    let exited = false;
    const before = linesSeen;
    const res = await runner.stream(req.target, buildFollowScript(req.runId, linesSeen + 1), {
      signal,
      onLine: (line) => {
        if (line === EXIT_MARKER) { exited = true; return 'stop'; }
        linesSeen += 1;
        return events.push(line) ? 'stop' : 'continue';
      },
    });
    if (signal.aborted) {
      await runner.exec(req.target, buildCancelScript(req.runId), { timeoutMs: CANCEL_TIMEOUT_MS }).catch(() => undefined);
      return { kind: 'aborted', pid };
    }
    const terminal = events.terminal();
    if (terminal?.type === 'done') return { kind: 'done', message: events.finalMessage(), pid, ...(terminal.metadata ? { metadata: terminal.metadata } : {}) };
    if (terminal?.type === 'error') return { kind: 'error', reason: `remote agent error: ${terminal.message}`, pid, partial: events.finalMessage() };
    if (exited) {
      const err = await runner.exec(req.target, buildErrTailScript(req.runId), { timeoutMs: CANCEL_TIMEOUT_MS });
      const tail = err.stdout.trim();
      return { kind: 'error', reason: `remote afk exited without a result${tail ? `: ${tail}` : ''}`, pid, partial: events.finalMessage() };
    }
    // Connection dropped mid-follow: reconnect from the next unseen line.
    lastStderr = res.stderr.trim();
    failures = linesSeen > before ? 1 : failures + 1;
    if (failures > MAX_RECONNECTS) {
      return { kind: 'lost', pid, reason: `lost connection to ${req.target} after ${MAX_RECONNECTS} reconnects${lastStderr ? ` (${lastStderr})` : ''}`, partial: events.finalMessage() };
    }
    await sleep(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1)), signal);
  }
}
