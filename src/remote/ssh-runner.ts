/**
 * Thin SSH transport for `remote_agent`. Injected as an interface so tests can
 * substitute an in-memory fake without spawning processes.
 *
 * Contract: every script runs as `/bin/sh -c <script>` on the remote, so the
 * remote login shell only has to parse one single-quoted argument. Options:
 * `BatchMode=yes` (never prompt for a password), `ConnectTimeout=5` (a
 * sleeping host fails fast), and ServerAlive probes (a dead link is noticed
 * within ~45 s, which is what lets the follow loop reconnect).
 *
 * @module remote/ssh-runner
 */

import { spawn } from 'node:child_process';
import { shQuote } from './remote-script.js';

export interface SshExecResult {
  /** Exit code; `null` when killed by a signal. ssh itself uses 255 for connection failures. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SshExecOptions {
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SshStreamOptions {
  signal: AbortSignal;
  /** Called per complete stdout line. Return `'stop'` to end the stream early. */
  onLine: (line: string) => 'continue' | 'stop';
}

export interface SshRunner {
  exec(target: string, script: string, opts?: SshExecOptions): Promise<SshExecResult>;
  stream(target: string, script: string, opts: SshStreamOptions): Promise<SshExecResult>;
}

/** Exit code ssh reports for connection/auth failures. */
export const SSH_CONNECT_FAILURE = 255;

const SSH_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=5',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];
const MAX_STDERR = 16_384;

/** Build the argv passed to the local `ssh` binary. */
export function sshArgs(target: string, script: string): string[] {
  return [...SSH_OPTIONS, '--', target, `/bin/sh -c ${shQuote(script)}`];
}

function spawnSsh(
  target: string,
  script: string,
  signal: AbortSignal | undefined,
  onStdout: (chunk: string, stop: () => void) => void,
  stdin?: string,
  timeoutMs?: number,
): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', sshArgs(target, script), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopRequested = false;
    const stop = (): void => {
      stopRequested = true;
      if (child.exitCode === null) child.kill('SIGTERM');
    };
    const timer = timeoutMs !== undefined ? setTimeout(stop, timeoutMs) : undefined;
    const onAbort = (): void => stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    };
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; onStdout(chunk, stop); });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });
    child.on('error', (err) => { stderr += String(err.message); finish(null); });
    // Invariant: after a requested stop, settle on 'exit', not 'close'. A
    // grandchild (the remote follow script's backgrounded `tail -f`, or any
    // process ssh left behind) can keep the stdout pipe open indefinitely, so
    // 'close' may never fire; the output we wanted has already been consumed.
    child.on('exit', (code) => {
      if (!stopRequested) return;
      child.stdout.destroy();
      child.stderr.destroy();
      finish(code);
    });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* remote closed stdin early; exit code reports the failure */ });
    child.stdin.end(stdin ?? '');
    if (signal?.aborted) stop();
  });
}

/** Default runner backed by the local OpenSSH client. */
export const defaultSshRunner: SshRunner = {
  exec(target, script, opts = {}) {
    return spawnSsh(target, script, opts.signal, () => {}, opts.stdin, opts.timeoutMs);
  },
  async stream(target, script, opts) {
    let buf = '';
    let stopped = false;
    const res = await spawnSsh(target, script, opts.signal, (chunk, stop) => {
      if (stopped) return;
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (opts.onLine(line) === 'stop') { stopped = true; stop(); return; }
        nl = buf.indexOf('\n');
      }
    });
    // Keep only the trailing fragment in the result; full lines went to onLine.
    return { ...res, stdout: buf };
  },
};
