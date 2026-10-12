/**
 * Opt-in, repo-declared post-create setup for afk-managed worktrees (#3601).
 *
 * A fresh worktree shares nothing ignored with the main checkout — no
 * `node_modules`, no nested-package installs, no generated files. A repo can
 * declare its own provisioning in `.afk/worktree-setup.json` (resolved via
 * `getProjectWorktreeSetupPath`, read from the NEW tree so the declaration
 * matches the checked-out base commit):
 *
 *   { "commands": ["pnpm install --frozen-lockfile"], "timeoutMs": 300000 }
 *
 * Contract: nothing runs unless the file exists. {@link runWorktreeSetup}
 * NEVER throws — every failure (bad JSON, non-zero exit, timeout, abort) is
 * returned as a {@link WorktreeSetupResult} so it can never reach the
 * `LOCK_CONTENTION` retry in `createIsolatedWorktree` and re-run
 * `git worktree add` on an already-created branch.
 *
 * Trust model: the commands come from the repository itself, the same trust
 * as running that repo's package scripts. Documented in
 * `docs/worktree-setup.md`.
 *
 * @module agent/worktree/worktree-setup
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { getProjectWorktreeSetupPath } from '../../paths.js';
import { resolveShell } from '../../utils/resolve-shell.js';
import { killProcessGroup } from '../../utils/kill-process-group.js';
import { scrubBashEnv } from '../tools/handlers/bash-env-scrub.js';
import { errorMessage, isErrnoCode } from '../../utils/errors.js';

/** Default per-run budget when the declaration omits `timeoutMs`. */
export const DEFAULT_WORKTREE_SETUP_TIMEOUT_MS = 5 * 60_000;
/** Max bytes of combined output retained for the failure detail. */
const OUTPUT_TAIL_BYTES = 2_000;

export type WorktreeSetupStatus = 'none' | 'ok' | 'failed' | 'timeout' | 'aborted' | 'invalid';

export interface WorktreeSetupResult {
  status: WorktreeSetupStatus;
  /** The exact command that failed / timed out / was aborted. */
  command?: string;
  /** Exit code, error message, or output tail explaining a non-ok status. */
  detail?: string;
  /** Commands that completed successfully, in order. */
  completed?: string[];
}

export interface WorktreeSetupDeclaration {
  commands: string[];
  timeoutMs: number;
}

/** Outcome of running one command. */
export type SetupCommandOutcome =
  | { kind: 'ok' }
  | { kind: 'failed'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/** Injectable command runner (tests). */
export type SetupCommandRunner = (
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<SetupCommandOutcome>;

/**
 * Read + validate the declaration. `undefined` = not declared (the no-op
 * path); a string = invalid declaration (reported, never thrown).
 */
export async function readWorktreeSetupDeclaration(
  worktreePath: string,
): Promise<WorktreeSetupDeclaration | undefined | string> {
  let raw: string;
  try {
    raw = await fs.readFile(getProjectWorktreeSetupPath(worktreePath), 'utf-8');
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT') || isErrnoCode(err, 'ENOTDIR')) return undefined;
    return `unreadable: ${errorMessage(err)}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `parse error: ${errorMessage(err)}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'top-level must be an object';
  }
  const obj = parsed as Record<string, unknown>;
  const commands = obj['commands'];
  if (!Array.isArray(commands) || !commands.every((c) => typeof c === 'string' && c.trim() !== '')) {
    return '"commands" must be an array of non-empty strings';
  }
  const t = obj['timeoutMs'];
  if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t) || t <= 0)) {
    return '"timeoutMs" must be a positive number';
  }
  return { commands: commands as string[], timeoutMs: (t as number | undefined) ?? DEFAULT_WORKTREE_SETUP_TIMEOUT_MS };
}

/** Default runner: platform shell via resolveShell(), process-group kill on timeout/abort. */
export const defaultSetupCommandRunner: SetupCommandRunner = (command, opts) =>
  new Promise((resolvePromise) => {
    const isWin32 = process.platform === 'win32';
    const shell = resolveShell();
    const spawnOpts = {
      cwd: opts.cwd,
      detached: !isWin32,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      env: scrubBashEnv(undefined),
    };
    let tail = '';
    let settled = false;
    const finish = (outcome: SetupCommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise(outcome);
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = shell.shell === true
        ? spawn(command, { shell: true, ...spawnOpts })
        : spawn(shell.shell, [...(shell.args ?? []), command], spawnOpts);
    } catch (err) {
      resolvePromise({ kind: 'failed', detail: errorMessage(err) });
      return;
    }
    // Invariant: on Windows, killProcessGroup sends SIGTERM/TerminateProcess but
    // the child may still hold open file handles until its close event fires.
    // Resolving the promise before close causes afterEach rmSync to race those
    // handles (EBUSY on Windows).  We therefore always resolve from the close
    // handler (never before it), so the caller returns only after the process
    // has fully exited and released its handles.
    //
    // On timeout/abort we record a pending kill outcome and let close fire
    // naturally, bounded by a grace timer that forces resolution if close is
    // unreasonably delayed (e.g. a zombie that never exits).
    const CLOSE_GRACE_MS = 5_000;
    let killOutcome: SetupCommandOutcome | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (outcome: SetupCommandOutcome): void => {
      if (killOutcome !== undefined) return; // already killing
      killOutcome = outcome;
      if (proc.pid !== undefined) killProcessGroup(proc.pid);
      // Grace timer: if the process never fires close, resolve after grace period.
      graceTimer = setTimeout(() => finish(outcome), CLOSE_GRACE_MS);
    };
    const onData = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf-8')).slice(-OUTPUT_TAIL_BYTES);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    const timer = setTimeout(() => { kill({ kind: 'timeout' }); }, opts.timeoutMs);
    const onAbort = (): void => { kill({ kind: 'aborted' }); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (err) => finish({ kind: 'failed', detail: errorMessage(err) }));
    proc.on('close', (code, sig) => {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      // If we killed the process, report the kill outcome (timeout/aborted),
      // not the resulting non-zero exit code.
      if (killOutcome !== undefined) { finish(killOutcome); return; }
      if (code === 0) finish({ kind: 'ok' });
      else finish({ kind: 'failed', detail: `exit ${code ?? sig ?? 'unknown'}${tail.trim() ? `: ${tail.trim()}` : ''}` });
    });
  });

/**
 * Run the declared setup in `worktreePath`, sequentially, stopping at the
 * first non-ok command. Returns `{ status: 'none' }` when nothing is declared.
 * Never throws (see module Contract).
 */
export async function runWorktreeSetup(args: {
  worktreePath: string;
  signal?: AbortSignal;
  runCommand?: SetupCommandRunner;
}): Promise<WorktreeSetupResult> {
  try {
    const decl = await readWorktreeSetupDeclaration(args.worktreePath);
    if (decl === undefined) return { status: 'none' };
    if (typeof decl === 'string') return { status: 'invalid', detail: decl };
    const run = args.runCommand ?? defaultSetupCommandRunner;
    const completed: string[] = [];
    for (const command of decl.commands) {
      if (args.signal?.aborted) return { status: 'aborted', command, completed };
      const outcome = await run(command, {
        cwd: args.worktreePath,
        timeoutMs: decl.timeoutMs,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
      if (outcome.kind === 'ok') { completed.push(command); continue; }
      if (outcome.kind === 'failed') return { status: 'failed', command, detail: outcome.detail, completed };
      if (outcome.kind === 'timeout') {
        return { status: 'timeout', command, detail: `exceeded ${decl.timeoutMs}ms`, completed };
      }
      return { status: 'aborted', command, completed };
    }
    return { status: 'ok', completed };
  } catch (err) {
    return { status: 'failed', detail: errorMessage(err) };
  }
}

/**
 * One-line, caller-facing notice for a setup that did NOT succeed; `undefined`
 * for `none`/`ok`. Names the exact command so the reader can re-run it.
 */
export function describeWorktreeSetupFailure(
  result: WorktreeSetupResult | undefined,
  worktreePath: string,
): string | undefined {
  if (result === undefined || result.status === 'none' || result.status === 'ok') return undefined;
  if (result.status === 'invalid') {
    return `[worktree-setup] .afk/worktree-setup.json is invalid (${result.detail ?? 'unknown'}); no setup ran in ${worktreePath}.`;
  }
  const what = result.status === 'timeout' ? 'timed out' : result.status === 'aborted' ? 'was aborted' : 'failed';
  const cmd = result.command !== undefined ? `\`${result.command}\`` : 'setup';
  const detail = result.detail !== undefined ? ` (${result.detail})` : '';
  return `[worktree-setup] ${cmd} ${what}${detail}. The worktree at ${worktreePath} is usable but may be missing dependencies; re-run ${cmd} there before building or testing.`;
}

/** Prepend a setup-failure notice (if any) to a tool result's content, in place. */
export function prependSetupNotice<T extends { content: string }>(notice: string | undefined, result: T): T {
  if (notice !== undefined) result.content = `${notice}\n\n${result.content}`;
  return result;
}
