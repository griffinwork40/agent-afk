/**
 * Private-index lifecycle for `git-snapshot.ts`: per-index serialisation,
 * first-use seeding from the repository's own index, and stale-lock recovery.
 *
 * Invariant: the user's index is only ever READ (stat + copyFile). Every write
 * targets `indexFile`, its `.lock`, or its `.root` sidecar.
 *
 * @module agent/file-checkpoint/git-snapshot.index
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { findConverting, globalAttributeFiles, systemAttributeFile, workTreeAttributeFiles } from './git-snapshot.attrs.js';
import { isOk, runIn, type GitCtx } from './git-snapshot.exec.js';

/**
 * Invariant: captures sharing one private index run one at a time. Two
 * concurrent `git add -A` runs on the same `GIT_INDEX_FILE` would collide on
 * its `.lock`; serialising also means a `.lock` present when our turn starts
 * can only be a leftover of a killed git, so it is safe to delete.
 */
const indexQueues = new Map<string, Promise<unknown>>();

export function withIndexLock<T>(indexFile: string, fn: () => Promise<T>): Promise<T> {
  const prev = indexQueues.get(indexFile) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  indexQueues.set(indexFile, tail);
  void tail.then(() => {
    if (indexQueues.get(indexFile) === tail) indexQueues.delete(indexFile);
  });
  return next;
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * True when the user's index has an entry whose stat data does not vouch for
 * its working-tree bytes: assume-unchanged (lowercase tag) or skip-worktree
 * (`S`/`s`) in `git ls-files -v`. A seeded copy of such an entry would make
 * `add -A` keep the stale blob and hide a real change.
 */
export function hasFlaggedEntries(lsFilesV: Buffer): boolean {
  for (const rec of lsFilesV.toString('utf8').split('\0')) {
    if (rec === '') continue;
    const tag = rec.charAt(0);
    if (tag === 'S' || tag !== tag.toUpperCase()) return true;
  }
  return false;
}

/**
 * Seeding is only correct when the repo's index blobs are the raw working-tree
 * bytes and every entry's stat data is trustworthy. Snapshots disable
 * attributes (no clean filters, no eol conversion), so a repo that converts
 * content would leave converted blobs for files whose stat is unchanged.
 * Invariant: never seed when ANY attribute file the user's git reads (every
 * `.gitattributes` at any depth, `info/attributes`, global, system) names a
 * converting attribute, when autocrlf is on, when sparse checkout is on, or
 * when the index carries assume-unchanged / skip-worktree entries. Any
 * uncertainty (a failed git call, an unknown system file) means "do not seed";
 * the cost is one full hash, never a wrong snapshot.
 * Contract: `ctx.env` must NOT carry GIT_INDEX_FILE (it reads the user's index).
 */
export async function seedingSafe(ctx: GitCtx, repoRoot: string, infoAttributes: string): Promise<boolean> {
  const config = async (key: string): Promise<string> => {
    const run = await runIn(ctx, repoRoot, ['config', '--get', key]);
    return isOk(run) ? run.stdout.toString('utf8').trim().toLowerCase() : '';
  };
  const autocrlf = await config('core.autocrlf');
  if (autocrlf !== '' && autocrlf !== 'false') return false;
  if (['true', 'yes', 'on', '1'].includes(await config('core.sparsecheckout'))) return false;
  const flags = await runIn(ctx, repoRoot, ['ls-files', '-v', '-z']);
  if (!isOk(flags) || hasFlaggedEntries(flags.stdout)) return false;
  const tree = await workTreeAttributeFiles(ctx, repoRoot);
  if (!Array.isArray(tree)) return false;
  const system = await systemAttributeFile(ctx, repoRoot);
  if (system === undefined) return false;
  const global = await globalAttributeFiles(ctx, repoRoot);
  return (await findConverting([infoAttributes, system, ...global, ...tree])) === null;
}

/**
 * Prepare `indexFile` for a capture of `repoRoot`. An existing private index
 * that already belongs to this repo is reused as-is. When it is missing or
 * belongs to another repo it is discarded, and `seed` decides whether the repo's
 * index is copied in. The copy keeps the source mtime so git's racy-entry check
 * behaves exactly as it would against the original.
 */
export async function preparePrivateIndex(
  indexFile: string,
  repoRoot: string,
  seed: () => Promise<string | null>,
): Promise<void> {
  await fs.mkdir(path.dirname(indexFile), { recursive: true });
  await fs.rm(`${indexFile}.lock`, { force: true });
  const marker = `${indexFile}.root`;
  const owner = await readIfExists(marker);
  const exists = await fs.stat(indexFile).then(() => true, () => false);
  if (exists && owner === repoRoot) return;
  await fs.rm(indexFile, { force: true });
  const source = await seed();
  if (source !== null) {
    try {
      const st = await fs.stat(source);
      await fs.copyFile(source, indexFile);
      await fs.utimes(indexFile, st.atime, st.mtime);
    } catch {
      // No usable repo index (fresh repo, or unreadable): start empty.
      await fs.rm(indexFile, { force: true });
    }
  }
  await fs.writeFile(marker, repoRoot, 'utf8');
}

/** Drop the private index and its owner marker. */
export async function discardPrivateIndex(indexFile: string): Promise<void> {
  await fs.rm(indexFile, { force: true });
  await fs.rm(`${indexFile}.root`, { force: true });
}
