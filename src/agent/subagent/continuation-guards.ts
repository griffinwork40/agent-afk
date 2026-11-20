/**
 * Fail-closed guards for subagent continuation (D3, D5).
 *
 * Contract: every function here returns a refusal string (the tool-error
 * reason) or undefined to proceed. Workspace checkpoints are captured from the
 * runtime-resolved cwd only, never from model text (fixes PR #2811 M-3).
 *
 * @module agent/subagent/continuation-guards
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { ChainDispatchInputs, ChainRecord, WorkspaceCheckpoint } from './continuation-registry.js';
import { GIT_READ_GLOBAL_ARGS, buildGitReadEnv } from '../tools/handlers/git-read.js';
import {
  enumerateFilterDrivers,
  filterNeutralisingEnv,
  guardSubmoduleArgv,
  type FilterDriverParse,
} from '../tools/handlers/git-read.exec-guard.js';

/** Continuation-call fields that must be omitted or equal to the chain's. */
export interface ContinuationOverrides {
  agent_type?: string;
  model?: string;
  cwd?: string;
  readRoots?: string[];
  writeRoots?: string[];
  isolation?: 'worktree';
  host?: string;
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined) return true;
  return b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);
}

/** D3: inherited fields are not overridable; remote host refused. */
export function checkContinuationOverrides(chain: ChainRecord, call: ContinuationOverrides): string | undefined {
  if (call.host !== undefined) return 'continuation is not supported for remote (`host`) dispatch';
  const stored: ChainDispatchInputs = chain.inputs;
  const conflicts: string[] = [];
  if (call.agent_type !== undefined && call.agent_type !== stored.agent_type) conflicts.push('agent_type');
  if (call.model !== undefined && call.model !== stored.model) conflicts.push('model');
  if (call.cwd !== undefined && call.cwd !== stored.cwd) conflicts.push('cwd');
  if (call.isolation !== undefined && call.isolation !== stored.isolation) conflicts.push('isolation');
  if (!sameList(call.readRoots, stored.readRoots)) conflicts.push('readRoots');
  if (!sameList(call.writeRoots, stored.writeRoots)) conflicts.push('writeRoots');
  if (conflicts.length > 0) {
    return `continuation inherits ${conflicts.join(', ')} from the chain; omit them or pass the chain's values`;
  }
  return undefined;
}

/** Outcome of one checkpoint git call: stdout on success, or why it failed. */
export type GitOutcome = { ok: true; stdout: string } | { ok: false; timedOut: boolean };

/**
 * Injectable git runner (tests); the default spawns `git` asynchronously.
 * The optional `env` parameter supplies the full child environment for the
 * call, including any filter-driver neutralisation entries built after
 * enumeration. Tests inject a fake that ignores the environment (they never
 * start real processes).
 */
export type CheckpointGitExec = (cwd: string, args: string[], env?: Record<string, string | undefined>) => Promise<GitOutcome>;

/**
 * Injectable driver enumerator (tests). Signature matches
 * {@link enumerateFilterDrivers} so the production default is a direct
 * reference. Tests inject a stub that returns `{ ok: true, names: [] }`.
 */
export type CheckpointEnumDrivers = (
  globalArgs: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
) => Promise<FilterDriverParse>;

/**
 * Global options on every checkpoint git call: the hardened read-only set from
 * handlers/git-read.ts. `--no-optional-locks` keeps `git status` from taking
 * index.lock while the parent or a sibling commits in the same worktree, and
 * `core.fsmonitor=false` (plus the pager/diff/gpg pins) stops a repo's own
 * config from running a program during the checkpoint. The child env drops
 * every inherited `GIT_*` override (no GIT_DIR redirection).
 */
export const CHECKPOINT_GIT_GLOBAL_ARGS: readonly string[] = GIT_READ_GLOBAL_ARGS;

/** Per-call timeout for checkpoint git calls (execFile kills with SIGKILL on expiry). */
export const CHECKPOINT_GIT_TIMEOUT_MS = 10_000;

/**
 * Grace after the per-call timeout before the call is abandoned outright.
 * execFile's callback fires only once the child exits AND its stdio closes; a
 * git that survives the kill (or a descendant holding the pipes open) would
 * otherwise never resolve. At the hard bound the child is SIGKILLed again and
 * the call resolves as timed out regardless.
 */
export const CHECKPOINT_GIT_KILL_GRACE_MS = 1_000;

/**
 * Overall bound on one checkpoint capture (repo probe + driver enumeration +
 * the parallel branch/HEAD/status calls), applied around the capture in
 * post-result settling and around the drift recapture in admission. On expiry
 * the checkpoint is treated as unavailable (drift fails closed). Sized above
 * the sequential per-call hard bounds so a slow-but-live git still completes.
 */
export const CHECKPOINT_CAPTURE_DEADLINE_MS = 25_000;

/** Async git (never blocks the event loop); never rejects, always settles within the hard bound. */
const defaultGitExec: CheckpointGitExec = (cwd, args, env) => new Promise((resolve) => {
  let settled = false;
  let hard: ReturnType<typeof setTimeout> | undefined;
  const finish = (outcome: GitOutcome): void => {
    if (settled) return;
    settled = true;
    if (hard !== undefined) clearTimeout(hard);
    resolve(outcome);
  };
  try {
    const child = execFile('git', args, {
      cwd, encoding: 'utf8', timeout: CHECKPOINT_GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: env ?? buildGitReadEnv(undefined),
    }, (err, stdout) => {
      if (err) finish({ ok: false, timedOut: (err as { killed?: boolean }).killed === true });
      else finish({ ok: true, stdout });
    });
    hard = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, timedOut: true });
    }, CHECKPOINT_GIT_TIMEOUT_MS + CHECKPOINT_GIT_KILL_GRACE_MS);
    hard.unref?.();
  } catch {
    finish({ ok: false, timedOut: false });
  }
});

/**
 * Run `capture(cwd)` under {@link CHECKPOINT_CAPTURE_DEADLINE_MS}. Expiry or
 * rejection yields an `unavailable` checkpoint (fail closed). Never rejects.
 */
export async function captureCheckpointWithin(
  cwd: string,
  capture: (cwd: string) => Promise<WorkspaceCheckpoint> = captureWorkspaceCheckpoint,
  ms: number = CHECKPOINT_CAPTURE_DEADLINE_MS,
): Promise<WorkspaceCheckpoint> {
  const unavailable: WorkspaceCheckpoint = { cwd, git: true, unavailable: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => capture(cwd)).catch(() => unavailable),
      new Promise<WorkspaceCheckpoint>((resolve) => { timer = setTimeout(() => resolve(unavailable), ms); timer.unref?.(); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * D5: capture {cwd, branch, HEAD, dirty fingerprint}; non-git cwd => `git: false`.
 * When `git status` (or the repo probe) fails or times out, the checkpoint is
 * marked `unavailable` instead of hashing an empty status: a drift check
 * against it fails closed. Never rejects.
 *
 * H6: before running the parallel data calls, the checkpoint enumerates every
 * filter driver configured in the repository (using `enumerateFilterDrivers`
 * from the git_read exec-guard, the same mechanism as the `git_read` handler)
 * and overrides each one through `GIT_CONFIG_COUNT` env vars.
 * `guardSubmoduleArgv` is applied to every call so `status` never enters a
 * submodule's repository with its own drivers. If driver enumeration fails the
 * checkpoint is marked `unavailable` (fail closed). The enumDrivers parameter
 * is injectable for unit tests; it defaults to the real `enumerateFilterDrivers`.
 */
export async function captureWorkspaceCheckpoint(
  cwd: string,
  exec: CheckpointGitExec = defaultGitExec,
  enumDrivers: CheckpointEnumDrivers = enumerateFilterDrivers,
): Promise<WorkspaceCheckpoint> {
  const baseEnv = buildGitReadEnv(undefined);
  const git = async (args: string[], env: Record<string, string | undefined>): Promise<GitOutcome> => {
    try { return await exec(cwd, [...CHECKPOINT_GIT_GLOBAL_ARGS, ...guardSubmoduleArgv(args)], env); } catch { return { ok: false, timedOut: false }; }
  };
  const inside = await git(['rev-parse', '--is-inside-work-tree'], baseEnv);
  // A timed-out probe is not proof of "not a repo": fail closed.
  if (!inside.ok && inside.timedOut) return { cwd, git: true, unavailable: true };
  if (!inside.ok || inside.stdout.trim() !== 'true') return { cwd, git: false };

  // H6: enumerate filter drivers via the exec-guard helper (which correctly
  // distinguishes exit-1-no-match from real errors). Fail closed on any
  // enumeration failure so the checkpoint never runs git status unprotected.
  const ac = new AbortController();
  const drivers = await enumDrivers(CHECKPOINT_GIT_GLOBAL_ARGS, cwd, baseEnv, ac.signal);
  if (!drivers.ok) return { cwd, git: true, unavailable: true };
  const guardedEnv: Record<string, string | undefined> = { ...baseEnv, ...filterNeutralisingEnv(drivers.names) };

  const [branchRaw, headRaw, statusRaw] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], guardedEnv),
    git(['rev-parse', 'HEAD'], guardedEnv),
    git(['status', '--porcelain=v1', '-z'], guardedEnv),
  ]);
  const branch = branchRaw.ok ? branchRaw.stdout.trim() : undefined;
  const head = headRaw.ok ? headRaw.stdout.trim() : undefined;
  const base = { cwd, git: true, ...(branch !== undefined ? { branch } : {}), ...(head !== undefined ? { head } : {}) };
  if (!statusRaw.ok) return { ...base, unavailable: true };
  return { ...base, dirtyFingerprint: createHash('sha256').update(statusRaw.stdout).digest('hex') };
}

/** Refusal when the admission-time recapture is unavailable (transient: retrying can succeed). */
export const CHECKPOINT_UNAVAILABLE_REASON =
  'workspace checkpoint unavailable (git status failed or timed out), so drift cannot be ruled out; retry the continuation';

/**
 * Refusal when the checkpoint stored at the chain's last run is unavailable.
 * Permanent for this chain: without that baseline, drift since the run ended
 * can never be ruled out, and only a new run on the chain would replace it.
 * A recapture is deliberately NOT accepted as a substitute baseline (fail closed).
 */
export const PRIOR_CHECKPOINT_UNAVAILABLE_REASON =
  "the workspace checkpoint from the chain's last run is unavailable (git status failed or timed out when it ended), " +
  'so drift since then cannot be ruled out; this chain cannot be continued: dispatch a new subagent instead';

/** D5: refuse on drift for write-capable chains; read-only and non-git skip. Unavailable (or deadline-expired) checkpoints fail closed. */
export async function checkWorkspaceDrift(chain: ChainRecord, recapture: (cwd: string) => Promise<WorkspaceCheckpoint> = captureWorkspaceCheckpoint): Promise<string | undefined> {
  if (!chain.inputs.writeCapable) return undefined;
  const prior = chain.checkpoint;
  if (prior === undefined) return undefined;
  if (prior.unavailable === true) return PRIOR_CHECKPOINT_UNAVAILABLE_REASON;
  if (!prior.git) return undefined;
  // Bounded: a git that never exits must not leave the chain `admitting` forever.
  const now = await captureCheckpointWithin(prior.cwd, recapture);
  if (now.unavailable === true) return CHECKPOINT_UNAVAILABLE_REASON;
  const drifted: string[] = [];
  if (!now.git) drifted.push('git repository');
  if (now.branch !== prior.branch) drifted.push(`branch (${prior.branch ?? '?'} -> ${now.branch ?? '?'})`);
  if (now.head !== prior.head) drifted.push(`HEAD (${prior.head?.slice(0, 9) ?? '?'} -> ${now.head?.slice(0, 9) ?? '?'})`);
  if (now.dirtyFingerprint !== prior.dirtyFingerprint) drifted.push('uncommitted changes');
  return drifted.length > 0 ? `workspace drifted since the chain's last run: ${drifted.join(', ')}` : undefined;
}
