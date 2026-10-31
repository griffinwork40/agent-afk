/**
 * Process plumbing for `git-snapshot.ts`: one argv-only git spawn bounded by a
 * shared deadline, the side-effect-free child env, and failure classification.
 *
 * Invariant: git is always spawned as `spawn('git', argv)` — never through a
 * shell (posix-guard R1) — and with every inherited `GIT_*` variable removed,
 * so a parent `GIT_DIR` / `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY` can never
 * redirect a snapshot into (or out of) the user's repository. The only `GIT_*`
 * variables a snapshot child sees are the ones `git-snapshot.ts` sets itself.
 *
 * @module agent/file-checkpoint/git-snapshot.exec
 */

import { spawn } from 'node:child_process';
import { buildChildEnv } from '../tools/handlers/bash-env-scrub.js';
import type { GitSnapshotFailure } from './git-snapshot.js';

export type GitEnv = Record<string, string | undefined>;

/**
 * Global options on every snapshot git call. Each pins a config that could
 * otherwise write outside the private index/object dir or spawn a helper:
 * auto-gc / auto-maintenance, the fsmonitor daemon, split-index shared files
 * (written into `.git/`), safecrlf aborts, and the embedded-repo advice.
 * `--no-optional-locks` keeps read-only commands from refreshing an index.
 */
export const GIT_SNAPSHOT_GLOBAL_ARGS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.splitIndex=false',
  '-c', 'core.safecrlf=false',
  '-c', 'advice.addEmbeddedRepo=false',
  '-c', 'color.ui=false',
  // Disable all credential helpers so no snapshot git call can prompt for or
  // store credentials (belt-and-suspenders alongside the env-var strip below).
  '-c', 'credential.helper=',
];

/**
 * Global args for one snapshot operation: the fixed set above plus
 * `core.hooksPath` pointed at an empty private directory, so writing the
 * private index can never run a user hook (`post-index-change`, …).
 */
export function snapshotArgs(hooksDir: string): string[] {
  if (/[=\n]/.test(hooksDir)) throw new Error(`git-snapshot: hooksDir contains invalid character ('=' or newline): ${hooksDir}`);
  return [...GIT_SNAPSHOT_GLOBAL_ARGS, '-c', `core.hooksPath=${hooksDir}`];
}

/** What every git call in one snapshot operation shares. */
export interface GitCtx { args: readonly string[]; env: GitEnv; deadline: number }

/**
 * Pattern matching env-var names that carry credentials. Any key whose name
 * (case-insensitive) ends in one of these suffixes is stripped, plus a
 * belt-and-suspenders list of well-known names that might not match the regex
 * (e.g. GOOGLE_APPLICATION_CREDENTIALS ends in _CREDENTIALS, not _CREDENTIAL).
 */
const CREDENTIAL_SUFFIX_RE = /_(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i;
const CREDENTIAL_EXACT: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

/** Inherited env (sanctioned builder) minus every `GIT_*` override and minus
 * every credential env var, so no secret leaks into a git subprocess. */
export function buildSnapshotEnv(): GitEnv {
  const base = buildChildEnv(undefined);
  for (const key of Object.keys(base)) {
    if (key.startsWith('GIT_') || CREDENTIAL_SUFFIX_RE.test(key) || CREDENTIAL_EXACT.includes(key)) {
      delete base[key];
    }
  }
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Never read $(prefix)/etc/gitattributes: its filters would run in `add`.
    GIT_ATTR_NOSYSTEM: '1',
    // Stable English diagnostics so "not a git repository" is matchable.
    LC_ALL: 'C',
  };
}

export interface GitRun {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

export interface RunOptions {
  cwd: string;
  env: GitEnv;
  /** Absolute epoch-ms deadline shared by every call in one operation. */
  deadline: number;
  input?: Buffer | string;
}

/** Grace between SIGTERM and SIGKILL once the deadline passes. */
const KILL_GRACE_MS = 500;

/**
 * Run `git <args>`; never rejects. On deadline, SIGTERM (git removes its own
 * lockfiles on SIGTERM) then SIGKILL after a grace period, and resolve only on
 * `close` so a killed git can never race a later call over the private index.
 */
export function runGit(args: readonly string[], opts: RunOptions): Promise<GitRun> {
  const remaining = opts.deadline - Date.now();
  if (remaining <= 0) {
    return Promise.resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true });
  }
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (r: GitRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(r);
    };
    let child;
    try {
      child = spawn('git', [...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, spawnError: err as NodeJS.ErrnoException });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, remaining);
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString('utf8'); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ code: null, stdout: Buffer.concat(out), stderr, timedOut, spawnError: err });
    });
    child.on('close', (code) => {
      finish({ code, stdout: Buffer.concat(out), stderr, timedOut });
    });
    if (opts.input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => { /* EPIPE when git exits early; the exit code reports it */ });
      child.stdin.end(opts.input);
    }
  });
}

export interface Failure { ok: false; reason: GitSnapshotFailure; detail?: string }

const NOT_GIT_PATTERNS = [/not a git repository/i, /must be run in a work tree/i];

/** Map a failed run to the contract's failure vocabulary. */
export function classifyFailure(run: GitRun, what: string): Failure {
  if (run.timedOut) return { ok: false, reason: 'timeout', detail: `${what} exceeded timeout` };
  if (run.spawnError !== undefined) {
    if (run.spawnError.code === 'ENOENT') {
      return { ok: false, reason: 'not-git', detail: `${what}: git not found or cwd missing` };
    }
    return { ok: false, reason: 'error', detail: `${what}: ${run.spawnError.message}`.slice(0, 200) };
  }
  if (NOT_GIT_PATTERNS.some((re) => re.test(run.stderr))) {
    return { ok: false, reason: 'not-git', detail: firstLine(run.stderr) };
  }
  return { ok: false, reason: 'error', detail: `${what} exited ${String(run.code)}: ${firstLine(run.stderr)}`.slice(0, 200) };
}

export function isOk(run: GitRun): boolean {
  return run.code === 0 && !run.timedOut && run.spawnError === undefined;
}

export function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 160);
}

/** `runGit` with the operation's shared args, env and deadline. */
export function runIn(ctx: GitCtx, cwd: string, args: readonly string[], input?: string): Promise<GitRun> {
  return runGit([...ctx.args, ...args], { cwd, env: ctx.env, deadline: ctx.deadline, ...(input !== undefined ? { input } : {}) });
}

/** PATH-style separator git uses for GIT_ALTERNATE_OBJECT_DIRECTORIES. */
const ALT_SEP = process.platform === 'win32' ? ';' : ':';

/**
 * One GIT_ALTERNATE_OBJECT_DIRECTORIES entry. Contract: git splits the value on
 * the PATH separator and C-unquotes an entry that starts with `"`, so a path
 * containing the separator or a double quote is emitted C-style quoted
 * (backslash, quote and control bytes escaped); any other path is passed as-is.
 *
 * Note: newline (`\n`) is included in the fast-path guard. A path with a
 * newline would not be split by the PATH separator, but git parses the
 * alternates file one path per line — a bare newline in the value would
 * truncate the entry. Including it in the C-quote trigger ensures it is always
 * octal-escaped (e.g. `\012`) rather than passed through literally.
 * Practical risk is low (paths come from the AFK state dir), but the check is
 * cheap and eliminates an ambiguous edge case.
 */
export function quoteAlternate(dir: string, sep: string = ALT_SEP): string {
  if (!dir.includes(sep) && !dir.includes('"') && !dir.includes('\n')) return dir;
  let out = '"';
  for (const byte of Buffer.from(dir, 'utf8')) {
    if (byte === 0x22 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte === 0x7f) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  // Multi-byte UTF-8 passes through unescaped; rebuild those bytes faithfully.
  return Buffer.from(`${out}"`, 'latin1').toString('utf8');
}
