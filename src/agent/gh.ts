/**
 * GitHub CLI (`gh`) agent-layer utilities.
 *
 * Pure agent-layer: no Telegraf knowledge, no Telegram imports. Provides:
 *   - `GhError`                — typed error class for `gh` failures
 *   - `checkGhReady`           — probes `gh` presence and auth with a module-level TTL cache
 *   - `createPr`               — creates a GitHub PR via `gh pr create`, returns the PR URL
 *   - `postPrComment`          — posts a comment to a PR via `gh pr comment --body-file -` (stdin)
 *   - `resolveCurrentBranchPr` — resolves the current branch's open PR number, or null
 *
 * All `gh` invocations use `execFile` / `spawn` (no shell) — branch refs and
 * titles come from the manifest, but argv isolation is the defence-in-depth.
 * `postPrComment` feeds the body through stdin so arbitrary markdown (backticks,
 * quotes, newlines) never has to survive argv-escaping or hit an argv length cap.
 *
 * @module agent/gh
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Exec timeout (P2): all execFileAsync calls get a 20 s hard timeout so a DNS
// stall or hung `gh` never blocks the Telegram callback window indefinitely.
// ---------------------------------------------------------------------------
const EXEC_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GhErrorKind =
  | 'not-found'
  | 'already-exists'
  | 'unauthed'
  | 'network'
  | 'timeout'
  | 'unknown';

export class GhError extends Error {
  public readonly kind: GhErrorKind;
  public readonly exitCode: number;
  public readonly stderr: string;

  constructor(message: string, kind: GhErrorKind, exitCode: number, stderr: string) {
    super(message);
    this.name = 'GhError';
    this.kind = kind;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export type GhReadiness = { ok: true } | { ok: false; hint: string };

export interface CreatePrOpts {
  base: string;
  head: string;
  title: string;
  body: string;
}

/**
 * Injected exec function — matches the shape of Node's promisified execFile
 * (file + args, no cwd). Defined here to keep the agent/ layer testable without
 * ever shelling out.
 */
export type ExecFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Module-level TTL cache for checkGhReady
// ---------------------------------------------------------------------------

let cache: { result: GhReadiness; expiresAt: number } | null = null;

// ---------------------------------------------------------------------------
// In-flight dedup for checkGhReady (C5)
// ---------------------------------------------------------------------------

let inflight: Promise<GhReadiness> | null = null;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal — test-only: wipe module-level state between test cases. */
export function _resetCacheForTest(): void {
  cache = null;
  inflight = null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function classifyStderr(stderr: string, code?: string, killed?: boolean): GhErrorKind {
  // P2: detect execFile timeout (killed by SIGTERM, or killed flag set with no exit code)
  if (killed === true) return 'timeout';
  if (code === 'ENOENT') return 'not-found';
  if (/already exists/i.test(stderr)) return 'already-exists';
  // C1: broader unauth pattern — HTTP 401/403, bad credentials, token, scope
  if (/authentication|please log in|HTTP 40[13]|bad credentials|token|scope/i.test(stderr))
    return 'unauthed';
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(stderr + (code ?? ''))) return 'network';
  return 'unknown';
}

function defaultExecFn(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  // P2: apply 20 s timeout to every execFileAsync call
  return execFileAsync(file, args, { timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGTERM' }).then(
    (r) => ({ stdout: r.stdout, stderr: r.stderr }),
  );
}

// ---------------------------------------------------------------------------
// checkGhReady
// ---------------------------------------------------------------------------

/**
 * Probes `gh --version` and `gh auth status` to decide whether the `gh` CLI
 * is present and authenticated.
 *
 * Caching policy (P1): only `ok: true` results are cached (60 s default TTL).
 * Failure results are never cached so a `gh auth login` takes effect on the
 * very next button press without waiting for the TTL to expire.
 *
 * In-flight dedup (C5): concurrent calls within a single event-loop cycle share
 * one probe Promise so Telegram double-taps don't generate two `gh` processes.
 *
 * P3: cache hit/miss is logged so the daemon log shows whether a probe ran.
 *
 * Pass `{ ttlMs: 0 }` in tests to bypass the cache; pass `{ execFn }` to inject
 * a mock exec.
 */
export async function checkGhReady(
  opts: { execFn?: ExecFn; ttlMs?: number; _now?: () => number; log?: (msg: string) => void } = {},
): Promise<GhReadiness> {
  const now = (opts._now ?? (() => Date.now()))();
  const ttlMs = opts.ttlMs ?? 60_000;
  const exec = opts.execFn ?? defaultExecFn;
  const log = opts.log ?? (() => {});

  // P1: only positive results are cached — failures must always re-probe
  if (cache && cache.expiresAt > now) {
    log('[gh] checkGhReady cache hit');
    return cache.result;
  }
  log('[gh] checkGhReady cache miss — probing');

  // C5: in-flight dedup — if a probe is already running, join it
  if (inflight) return inflight;

  const probe = async (): Promise<GhReadiness> => {
    // Step 1: check gh is on PATH
    try {
      await exec('gh', ['--version']);
    } catch (err: unknown) {
      const e = err as { code?: string; killed?: boolean };
      if (e.killed) {
        // P2: timeout
        return { ok: false, hint: '`gh` timed out — check connectivity' };
      }
      if (e.code === 'ENOENT') {
        return { ok: false, hint: '`gh` CLI not found — install with: brew install gh' };
      }
      // T1: non-ENOENT failure (e.g. EACCES)
      return { ok: false, hint: '`gh --version` failed unexpectedly — check gh installation' };
    }

    // Step 2: check gh is authenticated
    try {
      await exec('gh', ['auth', 'status']);
    } catch (err: unknown) {
      const e = err as { code?: string; killed?: boolean };
      // C6: network errors get a connectivity hint instead of an auth hint
      if (
        e.killed ||
        /ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(String((e as { code?: string }).code ?? ''))
      ) {
        return { ok: false, hint: 'check network — cannot reach GitHub' };
      }
      return { ok: false, hint: '`gh` is not authenticated — run: gh auth login' };
    }

    // P1: only cache successes
    const result: GhReadiness = { ok: true };
    if (ttlMs > 0) {
      cache = { result, expiresAt: now + ttlMs };
    }
    return result;
  };

  inflight = probe().finally(() => {
    inflight = null;
  });
  return inflight;
}

// ---------------------------------------------------------------------------
// createPr
// ---------------------------------------------------------------------------

/**
 * Creates a GitHub pull request via `gh pr create`.
 *
 * Returns the PR URL (trimmed). Throws `GhError` on any failure with a
 * discriminated `kind` field to let callers surface appropriate user messages.
 */
export async function createPr(opts: CreatePrOpts, execFn?: ExecFn): Promise<string> {
  const exec = execFn ?? defaultExecFn;
  const args = [
    'pr',
    'create',
    '--base',
    opts.base,
    '--head',
    opts.head,
    '--title',
    opts.title,
    '--body',
    opts.body,
  ];

  try {
    const { stdout } = await exec('gh', args);
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { code?: string; stderr?: string; exitCode?: number; killed?: boolean };
    const stderr = e.stderr ?? '';
    const code = e.code;
    const exitCode = e.exitCode ?? 1;
    const kind = classifyStderr(stderr, code, e.killed);
    throw new GhError(`gh pr create failed (${kind}): ${stderr.trim()}`, kind, exitCode, stderr);
  }
}

// ---------------------------------------------------------------------------
// postPrComment — post a review/comment body to a PR via stdin
// ---------------------------------------------------------------------------

/**
 * Exec function that feeds `input` to the child's stdin and captures stdout —
 * the shape required for `gh pr comment <ref> --body-file -`, where `-` reads
 * the body from stdin. Injectable so tests never spawn a real `gh`.
 */
export type ExecWithInputFn = (
  file: string,
  args: string[],
  input: string,
) => Promise<{ stdout: string; stderr: string }>;

/** Error shape `classifyStderr` reads — attached to rejections below. */
interface ExecError extends Error {
  stderr?: string;
  exitCode?: number;
  code?: string;
  killed?: boolean;
}

/**
 * Default stdin-feeding exec via `spawn` (no shell). Applies the same 20 s
 * hard timeout as `defaultExecFn`; on timeout the child is SIGTERM'd and the
 * rejection carries `killed: true` so `classifyStderr` maps it to `'timeout'`.
 */
function defaultExecWithInput(
  file: string,
  args: string[],
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGTERM');
    }, EXEC_TIMEOUT_MS);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(err.message), {
        ...(err.code !== undefined ? { code: err.code } : {}),
        stderr,
      }) as ExecError);
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        reject(Object.assign(new Error(`${file} timed out`), { killed: true, stderr }) as ExecError);
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(`${file} exited ${code ?? 'null'}`), {
        exitCode: code ?? 1,
        stderr,
      }) as ExecError);
    });

    // EPIPE guard: if `gh` exits before draining stdin, the write errors — the
    // close/error handler owns the real outcome, so swallow the stdin error.
    child.stdin?.on('error', () => { /* ignore */ });
    child.stdin?.end(input);
  });
}

export interface PostPrCommentOpts {
  /**
   * PR selector forwarded to `gh pr comment`: a number, a full PR URL, or a
   * branch name. Empty string → `gh` resolves the current branch's PR.
   */
  pr: string;
  /** Comment body (markdown). Sent via stdin, so any content is safe. */
  body: string;
}

/**
 * Post a comment to a GitHub PR via `gh pr comment <ref> --body-file -`,
 * feeding the body through stdin. Returns the created comment URL (trimmed,
 * may be empty if `gh` prints nothing). Throws `GhError` on failure with a
 * discriminated `kind`.
 */
export async function postPrComment(
  opts: PostPrCommentOpts,
  execFn?: ExecWithInputFn,
): Promise<string> {
  const exec = execFn ?? defaultExecWithInput;
  const args = ['pr', 'comment'];
  const ref = opts.pr.trim();
  if (ref) args.push(ref);
  args.push('--body-file', '-');

  try {
    const { stdout } = await exec('gh', args, opts.body);
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as ExecError;
    const stderr = e.stderr ?? '';
    const kind = classifyStderr(stderr, e.code, e.killed);
    throw new GhError(`gh pr comment failed (${kind}): ${stderr.trim()}`, kind, e.exitCode ?? 1, stderr);
  }
}

/**
 * Resolve the open PR number for the current branch via
 * `gh pr view --json number`. Returns the number as a string, or `null` when
 * there is no open PR for the branch (or `gh` fails) — never throws. Used to
 * give `--post github` a target when the review ran against a local diff.
 */
export async function resolveCurrentBranchPr(execFn?: ExecFn): Promise<string | null> {
  const exec = execFn ?? defaultExecFn;
  try {
    const { stdout } = await exec('gh', ['pr', 'view', '--json', 'number', '--jq', '.number']);
    const n = stdout.trim();
    return /^\d+$/.test(n) ? n : null;
  } catch {
    return null;
  }
}
