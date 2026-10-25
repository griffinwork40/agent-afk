/**
 * Per-turn snapshots for write_file, edit_file and patch_apply.
 * Bash mutations are not tracked. Digest-named entry directories contain
 * content and original-path metadata, published together by one rename.
 * Content-addressed session blobs deduplicate identical bytes across turns.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { stat, readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getFileCheckpointTurnDir } from '../../paths.js';
import { storeCheckpointContent } from './content-store.js';
import { isEnoent } from '../../utils/errors.js';

export interface FileCheckpointRegistry {
  snapshotFile(absPath: string): Promise<void>;
  readonly turnId: string;
  /** Paths whose pre-write snapshot was published this turn, in first-touch order. */
  touchedPaths(): string[];
}

export interface FileSnapshot {
  absPath: string;
  snapshotPath: string;
  isNewFile: boolean;
  mode?: number;
  contentHash?: string;
}

interface SnapshotMetadata {
  version: 3;
  contentHash?: string;
  absPath: string;
  isNewFile: boolean;
  mode?: number;
}

/** Read compatibility for pre-digest checkpoint filenames. */
export function decodePathKey(key: string): string {
  return Buffer.from(key, 'base64url').toString('utf8');
}
/** @deprecated Only unversioned legacy snapshots use an in-band sentinel. */
export const NEW_FILE_SENTINEL = '__afk_new_file__\n';

function turnDirectory(sessionId: string, turnId: string, stateDir?: string): string {
  return stateDir ? join(stateDir, 'file-checkpoints', sessionId, turnId)
    : getFileCheckpointTurnDir(sessionId, turnId);
}

async function capture(absPath: string): Promise<{ content: Buffer; metadata: SnapshotMetadata }> {
  try {
    const info = await stat(absPath);
    const content = await readFile(absPath);
    return { content, metadata: { version: 3, absPath, isNewFile: false, mode: info.mode & 0o7777 } };
  } catch (err) {
    if (!isEnoent(err)) throw err;
    return { content: Buffer.alloc(0), metadata: { version: 3, absPath, isNewFile: true } };
  }
}

async function publishSnapshot(turnDir: string, absPath: string, sessionId: string, stateDir?: string): Promise<void> {
  const key = createHash('sha256').update(absPath).digest('hex');
  const destination = join(turnDir, `${key}.entry`);
  if (existsSync(destination)) return;
  const { content, metadata } = await capture(absPath);
  await mkdir(turnDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(turnDir, '.pending-'));
  try {
    metadata.contentHash = await storeCheckpointContent(sessionId, content, join(staging, 'content'), stateDir);
    await writeFile(join(staging, 'metadata.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
    // Invariant: the nonempty directory rename publishes content AND metadata
    // atomically. A competing publisher cannot replace a committed directory.
    try {
      await rename(staging, destination);
    } catch (err) {
      const code = (err instanceof Error && 'code' in err) ? String((err as { code: unknown }).code) : undefined;
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code ?? '') || !existsSync(destination)) throw err;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function createFileCheckpointRegistry(
  sessionId: string, turnId: string, _stateDir?: string,
): FileCheckpointRegistry {
  const turnDir = turnDirectory(sessionId, turnId, _stateDir);
  const seen = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  return {
    turnId,
    touchedPaths: () => [...seen],
    async snapshotFile(absPath) {
      if (seen.has(absPath)) return;
      let task = pending.get(absPath);
      if (!task) {
        task = publishSnapshot(turnDir, absPath, sessionId, _stateDir);
        pending.set(absPath, task);
      }
      try {
        await task;
        // Invariant: failed I/O never authorizes rewind or poisons retries.
        seen.add(absPath);
      } finally {
        if (pending.get(absPath) === task) pending.delete(absPath);
      }
    },
  };
}

/** Registry creation is lazy; only an existing turn directory is a checkpoint. */
export function hasTurnCheckpoint(sessionId: string, turnId: string, _stateDir?: string): boolean {
  return existsSync(turnDirectory(sessionId, turnId, _stateDir));
}

export function listTurnSnapshots(sessionId: string, turnId: string, _stateDir?: string): FileSnapshot[] {
  const turnDir = turnDirectory(sessionId, turnId, _stateDir);
  if (!existsSync(turnDir)) return [];
  const legacy = !existsSync(join(turnDir, '.format'));
  const result: FileSnapshot[] = [];
  for (const entry of readdirSync(turnDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[a-f0-9]{64}\.entry$/.test(entry.name)) {
      const directory = join(turnDir, entry.name);
      const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8')) as SnapshotMetadata;
      if (metadata.version !== 3 || typeof metadata.absPath !== 'string' || typeof metadata.isNewFile !== 'boolean') {
        throw new Error(`Invalid checkpoint metadata: ${directory}`);
      }
      // Contract: contentHash format is validated in readCheckpointContent so a
      // single corrupt entry fails closed per-file without blocking sibling restores.
      if (metadata.contentHash !== undefined && typeof metadata.contentHash !== 'string') {
        throw new Error(`Invalid checkpoint content hash: ${directory}`);
      }
      if (metadata.mode !== undefined && (typeof metadata.mode !== 'number'
        || !Number.isFinite(metadata.mode) || !Number.isInteger(metadata.mode)
        || (metadata.mode & 0o6000) !== 0)) {
        throw new Error(`Invalid checkpoint mode: ${directory}`);
      }
      result.push({
        ...metadata,
        mode: metadata.mode === undefined ? undefined : metadata.mode & 0o7777,
        snapshotPath: join(directory, 'content'),
      });
    } else if (entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.new')) {
      const snapshotPath = join(turnDir, entry.name);
      result.push({
        absPath: decodePathKey(entry.name), snapshotPath,
        isNewFile: existsSync(`${snapshotPath}.new`) || (legacy && readFileSync(snapshotPath, 'utf8') === NEW_FILE_SENTINEL),
      });
    }
  }
  return result;
}
