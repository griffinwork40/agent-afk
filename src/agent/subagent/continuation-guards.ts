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

/** Async git (never blocks the event loop); undefined on any failure or the 10s timeout. Never rejects. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? undefined : stdout);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** D5: capture {cwd, branch, HEAD, dirty fingerprint}; non-git cwd => `git: false`. Never rejects. */
export async function captureWorkspaceCheckpoint(cwd: string): Promise<WorkspaceCheckpoint> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return { cwd, git: false };
  const [branchRaw, headRaw, statusRaw] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['status', '--porcelain=v1', '-z']),
  ]);
  const branch = branchRaw?.trim();
  const head = headRaw?.trim();
  const status = statusRaw ?? '';
  const dirtyFingerprint = createHash('sha256').update(status).digest('hex');
  return { cwd, git: true, ...(branch !== undefined ? { branch } : {}), ...(head !== undefined ? { head } : {}), dirtyFingerprint };
}

/** D5: refuse on drift for write-capable chains; read-only and non-git skip. */
export async function checkWorkspaceDrift(chain: ChainRecord, recapture: (cwd: string) => Promise<WorkspaceCheckpoint> = captureWorkspaceCheckpoint): Promise<string | undefined> {
  if (!chain.inputs.writeCapable) return undefined;
  const prior = chain.checkpoint;
  if (prior === undefined || !prior.git) return undefined;
  const now = await recapture(prior.cwd);
  const drifted: string[] = [];
  if (!now.git) drifted.push('git repository');
  if (now.branch !== prior.branch) drifted.push(`branch (${prior.branch ?? '?'} -> ${now.branch ?? '?'})`);
  if (now.head !== prior.head) drifted.push(`HEAD (${prior.head?.slice(0, 9) ?? '?'} -> ${now.head?.slice(0, 9) ?? '?'})`);
  if (now.dirtyFingerprint !== prior.dirtyFingerprint) drifted.push('uncommitted changes');
  return drifted.length > 0 ? `workspace drifted since the chain's last run: ${drifted.join(', ')}` : undefined;
}
