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
  EXIT_KEYCHAIN_UNLOCK,
  buildLaunchScript,
  buildFollowScript,
  buildCancelScript,
  buildErrTailScript,
} from './remote-script.js';
import { SSH_CONNECT_FAILURE, type SshRunner } from './ssh-runner.js';
import { createEventCollector } from './remote-events.js';
import { escapeForSecurityInteractive, unlockSetupCommand } from './keychain-unlock.js';

export const MAX_RECONNECTS = 6;
/** Stderr text afk prints when a headless run finds no Anthropic credential. */
export const NO_CREDENTIAL_SIGNATURE = 'No Anthropic credential found';

/**
 * Over SSH a Mac's login keychain is locked (per security session, even while
 * the user is logged in at the GUI), so keychain-stored OAuth is unreadable
 * and afk's "Run `afk login`" advice is wrong there. Two fixes: automatic
 * per-run unlock (`keychain-unlock.ts`), or a CLAUDE_CODE_OAUTH_TOKEN in the
 * host's afk.env, which is read before the keychain (src/config/env.auth.ts).
 */
export function lockedKeychainHint(hostName: string): string {
  return `\n\nHint: ${hostName} has no Anthropic credential available over SSH. ` +
    `If ${hostName} is a macOS host, its login keychain is likely locked over SSH: ` +
    `set "unlockKeychain": true for "${hostName}" in hosts.json and store ` +
    `its login password once on this machine with \`${unlockSetupCommand(hostName)}\`. ` +
    `Otherwise run \`afk login\` on ${hostName} directly and ensure the credential ` +
    `is readable in a non-interactive SSH session (e.g. via CLAUDE_CODE_OAUTH_TOKEN in that host's afk.env).`;
}
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
  /** Host name for messages and the keychain account (defaults to `target`). */
  hostName?: string;
  /** Remote login password (raw); when set, the launch unlocks the login keychain first. */
  keychainPassword?: string;
}

export type RemoteRunOutcome =
  | { kind: 'done'; message: string; pid: number; metadata?: Record<string, unknown> }
  | { kind: 'error'; reason: string; pid?: number; partial?: string; remoteDetail?: string }
  | { kind: 'aborted'; pid?: number }
  | { kind: 'lost'; reason: string; pid: number; partial?: string; remoteDetail?: string };

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
  const unlock = req.keychainPassword !== undefined;
  let keychainPassword: string | undefined;
  if (unlock) {
    try {
      keychainPassword = escapeForSecurityInteractive(req.keychainPassword ?? '');
    } catch (err) {
      return { kind: 'error', reason: (err as Error).message };
    }
  }
  // The prompt and keychain password are embedded inside the script as quoted
  // heredocs. stdin carries only the script — no trailing payload.
  const script = buildLaunchScript({
    ...req,
    prompt: req.prompt,
    ...(keychainPassword !== undefined ? { keychainPassword } : {}),
  });
  const res = await runner.exec(req.target, script, { signal, timeoutMs: LAUNCH_TIMEOUT_MS });
  if (signal.aborted) return { kind: 'aborted' };
  const stderr = res.stderr.trim();
  if (res.code === SSH_CONNECT_FAILURE) {
    return { kind: 'error', reason: `host unreachable (${req.target})`, remoteDetail: stderr || 'ssh exit 255' };
  }
  if (res.code === EXIT_AFK_NOT_FOUND) {
    return { kind: 'error', reason: `afk is not installed on ${req.target}. Install it there, or set "afkPath" for this host in hosts.json.`, remoteDetail: stderr };
  }
  if (res.code === EXIT_BAD_CWD) return { kind: 'error', reason: `remote cwd does not exist on ${req.target}`, remoteDetail: stderr };
  if (res.code === EXIT_KEYCHAIN_UNLOCK) {
    const name = req.hostName ?? req.target;
    return { kind: 'error', reason: `could not unlock the login keychain on ${req.target}; if its password changed, re-store it with \`${unlockSetupCommand(name)}\`` };
  }
  const line = res.stdout.split('\n').find((l) => l.startsWith(PID_MARKER));
  const pid = line !== undefined ? Number(line.slice(PID_MARKER.length).trim()) : NaN;
  if (res.code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    return { kind: 'error', reason: `remote launch failed on ${req.target} (exit ${String(res.code)})`, remoteDetail: stderr || res.stdout.trim() };
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
    if (terminal?.type === 'error') return { kind: 'error', reason: `remote agent error`, remoteDetail: terminal.message, pid, partial: events.finalMessage() };
    if (exited) {
      const err = await runner.exec(req.target, buildErrTailScript(req.runId), { timeoutMs: CANCEL_TIMEOUT_MS });
      const tail = err.stdout.trim();
      // An already-unlocked run that still lacks a credential needs `afk login`
      // on the host, not keychain advice, so the hint is skipped then.
      // NOTE: NO_CREDENTIAL_SIGNATURE check is on `tail` (local variable), not
      // on a remote-sourced field — so this matching is safe.
      const hint = tail.includes(NO_CREDENTIAL_SIGNATURE) && req.keychainPassword === undefined
        ? lockedKeychainHint(req.hostName ?? req.target)
        : '';
      return { kind: 'error', reason: `remote afk exited without a result${hint}`, remoteDetail: tail || undefined, pid, partial: events.finalMessage() };
    }
    // Connection dropped mid-follow: reconnect from the next unseen line.
    lastStderr = res.stderr.trim();
    failures = linesSeen > before ? 1 : failures + 1;
    if (failures > MAX_RECONNECTS) {
      return { kind: 'lost', pid, reason: `lost connection to ${req.target} after ${MAX_RECONNECTS} reconnects`, remoteDetail: lastStderr || undefined, partial: events.finalMessage() };
    }
    await sleep(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1)), signal);
  }
}
