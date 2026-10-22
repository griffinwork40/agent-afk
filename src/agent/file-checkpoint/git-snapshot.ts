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

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { diffWithEnv } from './git-snapshot.diff.js';
import {
  GIT_SNAPSHOT_GLOBAL_ARGS, buildSnapshotEnv, classifyFailure, isOk, runGit, type Failure, type GitEnv,
} from './git-snapshot.exec.js';
import { discardPrivateIndex, preparePrivateIndex, seedingSafe, withIndexLock } from './git-snapshot.index.js';

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

/** The empty tree per object format; GIT_ATTR_SOURCE points here to disable work-tree attributes. */
const EMPTY_TREE: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/**
 * Options that keep `add -A` byte-faithful and helper-free: no attribute
 * lookup from the work tree (no clean filters such as git-lfs, no eol/ident
 * conversion), no global attributes file, no autocrlf. The captured blobs are
 * then the exact on-disk bytes, which is what a rewind must write back.
 */
const ADD_ARGS: readonly string[] = [
  '-c', 'core.attributesFile=',
  '-c', 'core.autocrlf=false',
  // --ignore-errors: one unreadable file or an embedded repo with no commit
  // must not abort the whole snapshot; git exits 1 and indexes the rest.
  'add', '-A', '--ignore-errors', '--', '.',
];

/** Repo root → its real object directory (alternate) and empty-tree id, cached by capture. */
const repoLayouts = new Map<string, Pick<RepoLayout, 'objects' | 'emptyTree'>>();

interface RepoLayout { repoRoot: string; objects: string; index: string; infoAttributes: string; emptyTree: string }

async function locateRepo(cwd: string, env: GitEnv, deadline: number): Promise<RepoLayout | Failure> {
  const run = await runGit(
    [...GIT_SNAPSHOT_GLOBAL_ARGS, 'rev-parse', '--show-toplevel', '--show-object-format',
      '--git-path', 'objects', '--git-path', 'index', '--git-path', 'info/attributes'],
    { cwd, env, deadline },
  );
  if (!isOk(run)) return classifyFailure(run, 'git rev-parse');
  const [root, format, objects, index, info] = run.stdout.toString('utf8').split('\n');
  const emptyTree = EMPTY_TREE[format ?? ''];
  if (root === undefined || root === '' || emptyTree === undefined || objects === undefined || index === undefined || info === undefined) {
    return { ok: false, reason: 'error', detail: 'git rev-parse: unexpected output' };
  }
  // --git-path answers relative to the process cwd; --show-toplevel is absolute.
  return {
    repoRoot: path.resolve(root),
    objects: path.resolve(cwd, objects),
    index: path.resolve(cwd, index),
    infoAttributes: path.resolve(cwd, info),
    emptyTree,
  };
}

function privateEnv(base: GitEnv, objectDir: string, layout: Pick<RepoLayout, 'objects' | 'emptyTree'>, indexFile?: string): GitEnv {
  const env: GitEnv = {
    ...base,
    GIT_OBJECT_DIRECTORY: objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: layout.objects,
    GIT_ATTR_SOURCE: layout.emptyTree,
  };
  if (indexFile !== undefined) env['GIT_INDEX_FILE'] = indexFile;
  return env;
}

async function readAutocrlf(repoRoot: string, env: GitEnv, deadline: number): Promise<string> {
  const run = await runGit(['config', '--get', 'core.autocrlf'], { cwd: repoRoot, env, deadline });
  return isOk(run) ? run.stdout.toString('utf8').trim().toLowerCase() : '';
}

/** Steps after the repo is located; runs under the per-index lock. */
async function captureLocked(options: CaptureOptions, layout: RepoLayout, base: GitEnv, deadline: number): Promise<CaptureResult> {
  const { repoRoot } = layout;
  await fs.mkdir(options.objectDir, { recursive: true });
  await preparePrivateIndex(options.indexFile, repoRoot, async () => {
    const safe = await seedingSafe(repoRoot, layout.infoAttributes, await readAutocrlf(repoRoot, base, deadline));
    return safe ? layout.index : null;
  });
  const env = privateEnv(base, options.objectDir, layout, options.indexFile);
  const add = await runGit([...GIT_SNAPSHOT_GLOBAL_ARGS, ...ADD_ARGS], { cwd: repoRoot, env, deadline });
  // Exit 1 under --ignore-errors = "some paths could not be added"; the rest are.
  if (add.timedOut || add.spawnError !== undefined || (add.code !== 0 && add.code !== 1)) {
    // A private index git cannot use (e.g. a seed carrying a split-index link)
    // is discarded so the next capture rebuilds it from scratch.
    if (!add.timedOut) await discardPrivateIndex(options.indexFile);
    return classifyFailure(add, 'git add');
  }
  const write = await runGit([...GIT_SNAPSHOT_GLOBAL_ARGS, 'write-tree'], { cwd: repoRoot, env, deadline });
  if (!isOk(write)) return classifyFailure(write, 'git write-tree');
  const tree = write.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return { ok: false, reason: 'error', detail: 'git write-tree: unexpected output' };
  repoLayouts.set(repoRoot, { objects: layout.objects, emptyTree: layout.emptyTree });
  return { ok: true, repoRoot, tree };
}

export async function captureWorkspaceTree(options: CaptureOptions): Promise<CaptureResult> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  try {
    const base = buildSnapshotEnv();
    const layout = await locateRepo(options.cwd, base, deadline);
    if ('ok' in layout) return layout;
    return await withIndexLock(options.indexFile, () => captureLocked(options, layout, base, deadline));
  } catch (err) {
    return { ok: false, reason: 'error', detail: describe(err) };
  }
}

export async function diffTrees(options: DiffOptions): Promise<DiffResult> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  try {
    const base = buildSnapshotEnv();
    let layout = repoLayouts.get(options.repoRoot);
    if (layout === undefined) {
      const located = await locateRepo(options.repoRoot, base, deadline);
      if ('ok' in located) return located;
      layout = located;
    }
    // A missing GIT_OBJECT_DIRECTORY makes git report "not a git repository";
    // create it so an unknown tree id surfaces as the 'error' it really is.
    await fs.mkdir(options.objectDir, { recursive: true });
    return await diffWithEnv(options, privateEnv(base, options.objectDir, layout), deadline);
  } catch (err) {
    return { ok: false, reason: 'error', detail: describe(err) };
  }
}

function describe(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
