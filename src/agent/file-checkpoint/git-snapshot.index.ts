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

/** Attribute keys that make the index blob differ from working-tree bytes. */
const CONVERTING_ATTR = /\b(filter|eol|text|crlf|working-tree-encoding|ident)\b/;

async function readIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Seeding is only correct when the repo's index blobs are the raw working-tree
 * bytes. Snapshots disable attributes (no clean filters, no eol conversion), so
 * a repo that converts content would leave converted blobs for files whose stat
 * is unchanged. Detect the common cases cheaply and fall back to a full hash.
 * Contract: `autocrlf` is the repo's effective `core.autocrlf` value or ''.
 */
export async function seedingSafe(repoRoot: string, infoAttributes: string, autocrlf: string): Promise<boolean> {
  if (autocrlf !== '' && autocrlf !== 'false') return false;
  const rootAttrs = await readIfExists(path.join(repoRoot, '.gitattributes'));
  const infoAttrs = await readIfExists(infoAttributes);
  return !CONVERTING_ATTR.test(rootAttrs) && !CONVERTING_ATTR.test(infoAttrs);
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
