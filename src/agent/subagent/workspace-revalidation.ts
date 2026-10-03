/**
 * Workspace revalidation for subagent continuation chains.
 *
 * When a capped subagent emits a {@link SubagentHandoff} with a
 * `workspaceContext` snapshot, a coordinator intending to dispatch a
 * continuation child should validate the snapshot against live workspace
 * state BEFORE proceeding. This module provides that check.
 *
 * Design invariants:
 *  - Revalidation is advisory/informational: the result is a structured
 *    {@link WorkspaceRevalidationResult} that callers can act on — it does NOT
 *    abort dispatches automatically. The coordinator decides whether drift is
 *    fatal or acceptable.
 *  - Absent snapshot fields are not checked (safely indeterminate). Only
 *    fields present in the snapshot are compared against live state.
 *  - Git commands run with injectable `execFile` for test isolation. A git
 *    failure (not-a-repo, git absent) yields `'command_failed'` drift, not a
 *    throw — the revalidation result is always returned, never thrown.
 *  - This module is deliberately async: the git queries are inherently I/O
 *    and blocking would stall the event loop for heavy repos.
 *  - No permissions are required beyond reading git state. This is safe to
 *    call from any coordinator context.
 *
 * @module agent/subagent/workspace-revalidation
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileDefault = promisify(execFileCallback);

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Snapshot of workspace identity captured by a subagent at handoff time.
 * Matches the `workspaceContext` field of {@link SubagentHandoff}.
 */
export interface WorkspaceSnapshot {
  cwd?: string;
  gitBranch?: string;
  headSha?: string;
  dirtyCount?: number;
}

/**
 * A single field drift — one mismatch between the snapshot value and the
 * live-measured value at revalidation time.
 */
export interface FieldDrift {
  field: keyof WorkspaceSnapshot;
  /** Value in the handoff snapshot (may be undefined if not in snapshot). */
  snapshot: string | number | undefined;
  /** Value measured live at revalidation time. */
  live: string | number | undefined;
}

/**
 * Result of {@link revalidateWorkspace}. Always returned (never throws).
 */
export interface WorkspaceRevalidationResult {
  /** True iff every checked field matched (or no fields were present). */
  clean: boolean;
  /** List of detected mismatches; empty when `clean` is true. */
  drifts: FieldDrift[];
  /**
   * True when a git command failed during revalidation. The result is still
   * returned; callers should treat this as an indeterminate state rather than
   * a definitive drift.
   */
  commandFailed?: boolean;
  /**
   * Human-readable summary. A clean result returns an empty string.
   * Drift results describe what changed.
   */
  summary: string;
}

// ─── Injectable exec type (for tests) ────────────────────────────────────────

type ExecFn = (
  file: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Read the current git branch name, or `undefined` on failure.
 */
async function readGitBranch(cwd: string, exec: ExecFn): Promise<string | undefined> {
  try {
    const r = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const branch = r.stdout.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the current HEAD SHA (full), or `undefined` on failure.
 */
async function readHeadSha(cwd: string, exec: ExecFn): Promise<string | undefined> {
  try {
    const r = await exec('git', ['rev-parse', 'HEAD'], { cwd });
    const sha = r.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Count the number of dirty (modified or untracked) files, or `undefined` on
 * failure. Uses `git status --porcelain` — each output line is one dirty file.
 */
async function readDirtyCount(cwd: string, exec: ExecFn): Promise<number | undefined> {
  try {
    const r = await exec('git', ['status', '--porcelain'], { cwd });
    const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
    return lines.length;
  } catch {
    return undefined;
  }
}

/**
 * Validate a {@link WorkspaceSnapshot} against the live workspace state.
 *
 * Only fields present in the snapshot are checked. Fields absent from the
 * snapshot are considered indeterminate and do not contribute to `drifts`.
 * The `cwd` field itself is used as the working directory for git commands;
 * if absent, `fallbackCwd` is used.
 *
 * All git failures are caught and surfaced via `commandFailed: true` rather
 * than re-thrown — the coordinator always receives a result.
 */
export async function revalidateWorkspace(
  snapshot: WorkspaceSnapshot,
  opts?: {
    /** Working directory fallback when `snapshot.cwd` is absent. Defaults to `process.cwd()`. */
    fallbackCwd?: string;
    /** Injectable exec function for test isolation. */
    execFile?: ExecFn;
  },
): Promise<WorkspaceRevalidationResult> {
  const exec: ExecFn = opts?.execFile ?? execFileDefault;
  const cwd = snapshot.cwd ?? opts?.fallbackCwd ?? process.cwd();
  const drifts: FieldDrift[] = [];
  let commandFailed = false;

  // Branch check
  if (snapshot.gitBranch !== undefined) {
    const live = await readGitBranch(cwd, exec);
    if (live === undefined) {
      commandFailed = true;
    } else if (live !== snapshot.gitBranch) {
      drifts.push({ field: 'gitBranch', snapshot: snapshot.gitBranch, live });
    }
  }

  // HEAD SHA check — snapshot may be abbreviated; check prefix match.
  // Minimum 4 hex chars to avoid an empty or trivially-short snapshot SHA
  // from matching any SHA (defense against malformed handoff data).
  if (snapshot.headSha !== undefined && snapshot.headSha.length >= 4) {
    const live = await readHeadSha(cwd, exec);
    if (live === undefined) {
      commandFailed = true;
    } else {
      const snapSha = snapshot.headSha;
      const shorter = snapSha.length < live.length ? snapSha : live;
      const longer = shorter === snapSha ? live : snapSha;
      if (!longer.startsWith(shorter)) {
        drifts.push({ field: 'headSha', snapshot: snapSha, live });
      }
    }
  }

  // Dirty-file count check — treat as informational when it changes
  if (snapshot.dirtyCount !== undefined) {
    const live = await readDirtyCount(cwd, exec);
    if (live === undefined) {
      commandFailed = true;
    } else if (live !== snapshot.dirtyCount) {
      drifts.push({ field: 'dirtyCount', snapshot: snapshot.dirtyCount, live });
    }
  }

  const clean = drifts.length === 0 && !commandFailed;

  let summary = '';
  if (commandFailed && drifts.length === 0) {
    summary =
      'Workspace revalidation could not run git commands — treat state as indeterminate.';
  } else if (drifts.length > 0) {
    const lines = drifts.map(
      (d) => `  ${d.field}: snapshot=${String(d.snapshot)} live=${String(d.live)}`,
    );
    summary = `Workspace has drifted since handoff snapshot:\n${lines.join('\n')}`;
    if (commandFailed) summary += '\n  (additional git commands also failed)';
  }

  return {
    clean,
    drifts,
    ...(commandFailed ? { commandFailed: true } : {}),
    summary,
  };
}
