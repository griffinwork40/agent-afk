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

/** D3: inherited fields are not overridable; worktree chains and remote host refused. */
export function checkContinuationOverrides(chain: ChainRecord, call: ContinuationOverrides): string | undefined {
  if (call.host !== undefined) return 'continuation is not supported for remote (`host`) dispatch';
  const stored: ChainDispatchInputs = chain.inputs;
  if (stored.isolation === 'worktree') return 'continuation of an `isolation: "worktree"` chain is not supported (v1)';
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

/** Injectable git runner (tests); the default spawns `git` asynchronously. */
export type CheckpointGitExec = (cwd: string, args: string[]) => Promise<GitOutcome>;

/**
 * Global options on every checkpoint git call: the hardened read-only set from
 * handlers/git-read.ts. `--no-optional-locks` keeps `git status` from taking
 * index.lock while the parent or a sibling commits in the same worktree, and
 * `core.fsmonitor=false` (plus the pager/diff/gpg pins) stops a repo's own
 * config from running a program during the checkpoint. The child env drops
 * every inherited `GIT_*` override (no GIT_DIR redirection).
 */
export const CHECKPOINT_GIT_GLOBAL_ARGS: readonly string[] = GIT_READ_GLOBAL_ARGS;

/** Per-call timeout for checkpoint git calls. */
export const CHECKPOINT_GIT_TIMEOUT_MS = 10_000;

/** Async git (never blocks the event loop); never rejects. */
const defaultGitExec: CheckpointGitExec = (cwd, args) => new Promise((resolve) => {
  try {
    execFile('git', args, {
      cwd, encoding: 'utf8', timeout: CHECKPOINT_GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      env: buildGitReadEnv(undefined),
    }, (err, stdout) => {
      if (err) resolve({ ok: false, timedOut: (err as { killed?: boolean }).killed === true });
      else resolve({ ok: true, stdout });
    });
  } catch {
    resolve({ ok: false, timedOut: false });
  }
});

/**
 * D5: capture {cwd, branch, HEAD, dirty fingerprint}; non-git cwd => `git: false`.
 * When `git status` (or the repo probe) fails or times out, the checkpoint is
 * marked `unavailable` instead of hashing an empty status: a drift check
 * against it fails closed. Never rejects.
 */
export async function captureWorkspaceCheckpoint(cwd: string, exec: CheckpointGitExec = defaultGitExec): Promise<WorkspaceCheckpoint> {
  const git = async (args: string[]): Promise<GitOutcome> => {
    try { return await exec(cwd, [...CHECKPOINT_GIT_GLOBAL_ARGS, ...args]); } catch { return { ok: false, timedOut: false }; }
  };
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  // A timed-out probe is not proof of "not a repo": fail closed.
  if (!inside.ok && inside.timedOut) return { cwd, git: true, unavailable: true };
  if (!inside.ok || inside.stdout.trim() !== 'true') return { cwd, git: false };
  const [branchRaw, headRaw, statusRaw] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain=v1', '-z']),
  ]);
  const branch = branchRaw.ok ? branchRaw.stdout.trim() : undefined;
  const head = headRaw.ok ? headRaw.stdout.trim() : undefined;
  const base = { cwd, git: true, ...(branch !== undefined ? { branch } : {}), ...(head !== undefined ? { head } : {}) };
  if (!statusRaw.ok) return { ...base, unavailable: true };
  return { ...base, dirtyFingerprint: createHash('sha256').update(statusRaw.stdout).digest('hex') };
}

/** Refusal when a write-capable chain's checkpoint (prior or recaptured) is unavailable. */
export const CHECKPOINT_UNAVAILABLE_REASON =
  'workspace checkpoint unavailable (git status failed or timed out), so drift cannot be ruled out; retry the continuation';

/** D5: refuse on drift for write-capable chains; read-only and non-git skip. Unavailable checkpoints fail closed. */
export async function checkWorkspaceDrift(chain: ChainRecord, recapture: (cwd: string) => Promise<WorkspaceCheckpoint> = captureWorkspaceCheckpoint): Promise<string | undefined> {
  if (!chain.inputs.writeCapable) return undefined;
  const prior = chain.checkpoint;
  if (prior === undefined) return undefined;
  if (prior.unavailable === true) return CHECKPOINT_UNAVAILABLE_REASON;
  if (!prior.git) return undefined;
  let now: WorkspaceCheckpoint;
  try { now = await recapture(prior.cwd); } catch { return CHECKPOINT_UNAVAILABLE_REASON; }
  if (now.unavailable === true) return CHECKPOINT_UNAVAILABLE_REASON;
  const drifted: string[] = [];
  if (!now.git) drifted.push('git repository');
  if (now.branch !== prior.branch) drifted.push(`branch (${prior.branch ?? '?'} -> ${now.branch ?? '?'})`);
  if (now.head !== prior.head) drifted.push(`HEAD (${prior.head?.slice(0, 9) ?? '?'} -> ${now.head?.slice(0, 9) ?? '?'})`);
  if (now.dirtyFingerprint !== prior.dirtyFingerprint) drifted.push('uncommitted changes');
  return drifted.length > 0 ? `workspace drifted since the chain's last run: ${drifted.join(', ')}` : undefined;
}
