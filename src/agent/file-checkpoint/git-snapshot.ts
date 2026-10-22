/**
 * Git-backed workspace snapshots for bash side-effect capture (#4271 stage 2).
 *
 * Contract (frozen interface between the snapshot implementation and the bash
 * integration in `bash-checkpoint.ts`; change it only in both places):
 *
 *   captureWorkspaceTree — record the current working tree of the git repo
 *     containing `cwd` (tracked files plus untracked, non-ignored files) as a
 *     git tree object, WITHOUT modifying the user's repository: no write to
 *     `.git/index`, no `index.lock`, no new objects under `.git/objects`, no
 *     refs, no hooks. All writes go to the session-private `objectDir` and
 *     `indexFile` (GIT_OBJECT_DIRECTORY / GIT_INDEX_FILE, with the repo's own
 *     object store as a read-only alternate).
 *
 *   diffTrees — paths whose content differs between two captured trees, each
 *     with its bytes and mode in the BEFORE tree (`prior: null` when the path
 *     did not exist before, i.e. the command created it).
 *
 * Both are best-effort and never throw: failures resolve to `{ ok: false }`.
 * Both are bounded by `timeoutMs`; `diffTrees` reports at most `maxFiles`
 * changes and sets `truncated` when more exist.
 *
 * @module agent/file-checkpoint/git-snapshot
 */

/** Why a capture or diff produced no usable result. */
export type GitSnapshotFailure =
  | 'not-git'      // cwd is not inside a git work tree, or git is not installed
  | 'timeout'      // exceeded timeoutMs
  | 'error';       // anything else (detail says what)

export interface CaptureOptions {
  /** Directory the command runs in; the enclosing work tree is captured. */
  cwd: string;
  /** Session-private object store (created if missing). */
  objectDir: string;
  /** Session-private index file, reused across captures for speed. */
  indexFile: string;
  timeoutMs: number;
}

export type CaptureResult =
  | { ok: true; repoRoot: string; tree: string }
  | { ok: false; reason: GitSnapshotFailure; detail?: string };

export interface DiffOptions {
  repoRoot: string;
  objectDir: string;
  before: string;
  after: string;
  maxFiles: number;
  timeoutMs: number;
}

/** One path whose content changed between the two trees. */
export interface TreeChange {
  /** Absolute path (repoRoot joined with the git path, platform separators). */
  absPath: string;
  /** Content before the command; `null` when the path did not exist. */
  prior: { bytes: Buffer; mode: number } | null;
}

/** A changed path that cannot be restored as a regular file (symlink, submodule). */
export interface SkippedChange {
  absPath: string;
  reason: string;
}

export type DiffResult =
  | { ok: true; changes: TreeChange[]; skipped: SkippedChange[]; truncated: boolean }
  | { ok: false; reason: GitSnapshotFailure; detail?: string };

export async function captureWorkspaceTree(_options: CaptureOptions): Promise<CaptureResult> {
  return { ok: false, reason: 'error', detail: 'not implemented' };
}

export async function diffTrees(_options: DiffOptions): Promise<DiffResult> {
  return { ok: false, reason: 'error', detail: 'not implemented' };
}
