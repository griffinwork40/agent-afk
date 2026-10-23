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
 * changes and sets `truncated` when more exist. A prior blob larger than
 * `MAX_BLOB_BYTES` (64 MiB) is reported in `skipped` and never read.
 *
 * Byte fidelity: every blob is the exact on-disk bytes. On git that honours
 * `--attr-source`, in-tree `.gitattributes` are ignored via the empty tree;
 * the global and system attribute files are always off (`core.attributesFile=`,
 * GIT_ATTR_NOSYSTEM=1). Any content-converting attribute that could still
 * apply — `info/attributes` always, and on older git every `.gitattributes`
 * at any depth plus the global file — makes capture refuse with
 * `unsafe-attributes` (see `git-snapshot.attrs.ts`). User hooks never run
 * (`core.hooksPath` is an empty private directory next to `objectDir`).
 *
 * Known side effects and limits:
 *   - git may refresh the mtime of an object it finds in the user's object
 *     store (the alternate) to mark it recently used; content never changes.
 *   - Restored files get git's tree mode (0644 or 0755), not their original
 *     permission bits.
 *   - Files `add` cannot read are omitted and the ok result carries `partial`.
 *
 * @module agent/file-checkpoint/git-snapshot
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { attrSourceSupported, captureAttributeCheck } from './git-snapshot.attrs.js';
import { diffWithCtx } from './git-snapshot.diff.js';
import {
  buildSnapshotEnv, classifyFailure, firstLine, isOk, quoteAlternate, runIn, snapshotArgs,
  type Failure, type GitCtx, type GitEnv,
} from './git-snapshot.exec.js';
import { discardPrivateIndex, preparePrivateIndex, seedingSafe, withIndexLock } from './git-snapshot.index.js';

export { MAX_BLOB_BYTES } from './git-snapshot.diff.js';

/** Why a capture or diff produced no usable result. */
export type GitSnapshotFailure =
  | 'not-git'      // cwd is not inside a git work tree, or git is not installed
  | 'timeout'      // exceeded timeoutMs
  | 'unsafe-attributes' // a content-converting attribute would make blobs differ from disk bytes
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
  /** `partial`: some files could not be read and are missing from `tree`. */
  | { ok: true; repoRoot: string; tree: string; partial?: string }
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

/** The empty tree per object format; `--attr-source` points here to disable work-tree attributes. */
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
  // Invariant: core.attributesFile= stays empty (no global attributes file).
  '-c', 'core.attributesFile=',
  '-c', 'core.autocrlf=false',
  // --ignore-errors: one unreadable file or an embedded repo with no commit
  // must not abort the whole snapshot; git exits 1 and indexes the rest.
  'add', '-A', '--ignore-errors', '--', '.',
];

/** Repo root → its real object directory (alternate) and empty-tree id, cached by capture. */
const repoLayouts = new Map<string, Pick<RepoLayout, 'objects'>>();

interface RepoLayout { repoRoot: string; objects: string; index: string; infoAttributes: string; emptyTree: string }

async function locateRepo(cwd: string, ctx: GitCtx): Promise<RepoLayout | Failure> {
  const run = await runIn(ctx, cwd, ['rev-parse', '--show-toplevel', '--show-object-format',
    '--git-path', 'objects', '--git-path', 'index', '--git-path', 'info/attributes']);
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

function privateEnv(base: GitEnv, objectDir: string, objects: string, indexFile?: string): GitEnv {
  const env: GitEnv = {
    ...base,
    GIT_OBJECT_DIRECTORY: objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternate(objects),
  };
  if (indexFile !== undefined) env['GIT_INDEX_FILE'] = indexFile;
  return env;
}

/** Empty private hooks directory beside `objectDir`; `core.hooksPath` points here. */
function hooksDirFor(objectDir: string): string {
  return path.join(path.dirname(objectDir), `${path.basename(objectDir)}-hooks`);
}

/** Steps after the repo is located; runs under the per-index lock. */
async function captureLocked(
  options: CaptureOptions, layout: RepoLayout, ctx: GitCtx, attrSourceArgs: readonly string[],
): Promise<CaptureResult> {
  const { repoRoot } = layout;
  await preparePrivateIndex(options.indexFile, repoRoot, async () => {
    const safe = await seedingSafe(ctx, repoRoot, layout.infoAttributes);
    return safe ? layout.index : null;
  });
  const priv: GitCtx = { ...ctx, args: [...ctx.args, ...attrSourceArgs], env: privateEnv(ctx.env, options.objectDir, layout.objects, options.indexFile) };
  const add = await runIn(priv, repoRoot, ADD_ARGS);
  // Exit 1 under --ignore-errors = "some paths could not be added"; the rest are.
  if (add.timedOut || add.spawnError !== undefined || (add.code !== 0 && add.code !== 1)) {
    // A private index git cannot use (e.g. a seed carrying a split-index link)
    // is discarded so the next capture rebuilds it from scratch.
    if (!add.timedOut) await discardPrivateIndex(options.indexFile);
    return classifyFailure(add, 'git add');
  }
  const write = await runIn(priv, repoRoot, ['write-tree']);
  if (!isOk(write)) return classifyFailure(write, 'git write-tree');
  const tree = write.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return { ok: false, reason: 'error', detail: 'git write-tree: unexpected output' };
  repoLayouts.set(repoRoot, { objects: layout.objects });
  if (add.code === 1) {
    const partial = `some files could not be read and were not captured: ${firstLine(add.stderr)}`.slice(0, 200);
    return { ok: true, repoRoot, tree, partial };
  }
  return { ok: true, repoRoot, tree };
}

/** Resolve attribute safety: the `--attr-source` args to use, or why capture must refuse. */
async function attributeArgs(ctx: GitCtx, layout: RepoLayout): Promise<string[] | Failure> {
  const supported = await attrSourceSupported(ctx, layout.repoRoot, layout.emptyTree);
  if (supported === null) return { ok: false, reason: 'timeout', detail: 'git --attr-source probe exceeded timeout' };
  const unsafe = await captureAttributeCheck(ctx, layout.repoRoot, layout.infoAttributes, supported);
  if (unsafe !== null) return unsafe;
  return supported ? [`--attr-source=${layout.emptyTree}`] : [];
}

export async function captureWorkspaceTree(options: CaptureOptions): Promise<CaptureResult> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  try {
    const hooksDir = hooksDirFor(options.objectDir);
    await fs.mkdir(options.objectDir, { recursive: true });
    await fs.mkdir(hooksDir, { recursive: true });
    const ctx: GitCtx = { args: snapshotArgs(hooksDir), env: buildSnapshotEnv(), deadline };
    const layout = await locateRepo(options.cwd, ctx);
    if ('ok' in layout) return layout;
    const attrArgs = await attributeArgs(ctx, layout);
    if (!Array.isArray(attrArgs)) return attrArgs;
    return await withIndexLock(options.indexFile, () => captureLocked(options, layout, ctx, attrArgs));
  } catch (err) {
    return { ok: false, reason: 'error', detail: describe(err) };
  }
}

export async function diffTrees(options: DiffOptions): Promise<DiffResult> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  try {
    const ctx: GitCtx = { args: snapshotArgs(hooksDirFor(options.objectDir)), env: buildSnapshotEnv(), deadline };
    let layout = repoLayouts.get(options.repoRoot);
    if (layout === undefined) {
      const located = await locateRepo(options.repoRoot, ctx);
      if ('ok' in located) return located;
      layout = located;
    }
    // A missing GIT_OBJECT_DIRECTORY makes git report "not a git repository";
    // create it so an unknown tree id surfaces as the 'error' it really is.
    await fs.mkdir(options.objectDir, { recursive: true });
    await fs.mkdir(hooksDirFor(options.objectDir), { recursive: true });
    return await diffWithCtx(options, { ...ctx, env: privateEnv(ctx.env, options.objectDir, layout.objects) });
  } catch (err) {
    return { ok: false, reason: 'error', detail: describe(err) };
  }
}

function describe(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
