/** Session-local content-addressed copies; entry hardlinks preserve the v3 format. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, link, copyFile, rename, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFileCheckpointBlobDir } from '../../paths.js';
import type { FileSnapshot } from './file-checkpoint.js';

/** Publish complete bytes before exposing an entry; never overwrite a shared blob. */
export async function storeCheckpointContent(
  sessionId: string, content: Buffer, destination: string, stateDir?: string,
): Promise<string> {
  const directory = getFileCheckpointBlobDir(sessionId, stateDir);
  const digest = createHash('sha256').update(content).digest('hex');
  const blobDirectory = join(directory, digest);
  const blob = join(blobDirectory, 'content');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, '.pending-'));
  try {
    await writeFile(join(staging, 'content'), content, { flag: 'wx', mode: 0o600 });
    // Invariant: a nonempty-directory rename publishes complete bytes without
    // replacing the winner when separate turns publish the same digest.
    try { await rename(staging, blobDirectory); }
    catch (err) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      // Windows can report permission-shaped errors for a rename collision;
      // retain the original error if there is no readable committed winner.
      const winner = await readFile(blob).catch(() => { throw err; });
      if (!winner.equals(content)) throw new Error(`Corrupt checkpoint content: ${digest}`);
    }
    try { await link(blob, destination); }
    catch (err) {
      // Preserve correctness on filesystems that cannot deduplicate hardlinks.
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      await copyFile(blob, destination);
    }
    return digest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Legacy entries have no digest; new entries verify integrity before restore. */
export function readCheckpointContent(snapshot: FileSnapshot): Buffer {
  const content = readFileSync(snapshot.snapshotPath);
  if (snapshot.contentHash !== undefined
    && createHash('sha256').update(content).digest('hex') !== snapshot.contentHash) {
    throw new Error(`Corrupt checkpoint content: ${snapshot.absPath}`);
  }
  return content;
}
