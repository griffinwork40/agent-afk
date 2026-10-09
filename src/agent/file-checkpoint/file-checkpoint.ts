/**
 * File checkpoint registry — snapshot file content before file-writing tool
 * calls (write_file, edit_file, patch_apply) so those mutations can be
 * undone per user-turn via {@link rewindFiles}.
 *
 * Snapshots are stored under:
 *   `<stateDir>/file-checkpoints/<sessionId>/<turnId>/<base64url(absPath)>`
 *
 * One snapshot file per unique absolute path per turn. The FIRST write in a
 * turn wins (EEXIST on the snapshot write is silently swallowed) so that
 * re-trying the same file within a single turn only ever captures the
 * pre-turn state, not an intermediate state.
 *
 * Bash-made file mutations are out of scope: the bash handler does not call
 * snapshotFile and therefore those mutations are not tracked.
 *
 * @module agent/file-checkpoint/file-checkpoint
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { stat, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getFileCheckpointTurnDir } from '../../paths.checkpoint.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Opaque handle passed through ToolHandlerContext to tool handlers. */
export interface FileCheckpointRegistry {
  /** Snapshot `absPath` under this turn's checkpoint dir (idempotent per path). */
  snapshotFile(absPath: string): Promise<void>;
  /** The stable turn id this registry was built for. */
  readonly turnId: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Encode an absolute path to a safe filesystem component.
 * We use base64url (no slashes, no padding) so paths with any chars survive.
 */
function encodePathKey(absPath: string): string {
  return Buffer.from(absPath, 'utf8').toString('base64url');
}

/**
 * Decode a base64url key back to its original path.
 * Used by rewindFiles to recover the original destination path.
 */
export function decodePathKey(key: string): string {
  return Buffer.from(key, 'base64url').toString('utf8');
}

// ---------------------------------------------------------------------------
// Sentinel for a file that did not exist before the turn
// ---------------------------------------------------------------------------

/** Sentinel byte sequence stored for files that did not exist pre-turn. */
export const NEW_FILE_SENTINEL = '__afk_new_file__\n';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a FileCheckpointRegistry for `sessionId` / `turnId` pair.
 *
 * All snapshots for this registry land at:
 *   `getFileCheckpointTurnDir(sessionId, turnId)/<key>`
 *
 * `_stateDir` is used by tests to override the state directory without
 * setting env vars. Production callers always leave it undefined.
 * @internal
 */
export function createFileCheckpointRegistry(
  sessionId: string,
  turnId: string,
  _stateDir?: string,
): FileCheckpointRegistry {
  // Lazily create the turn dir — first snapshotFile call creates it.
  const turnDir = _stateDir
    ? join(_stateDir, 'file-checkpoints', sessionId, turnId)
    : getFileCheckpointTurnDir(sessionId, turnId);
  // Track which paths have been snapshotted in this registry instance (process-local
  // dedup in addition to the EEXIST filesystem guard).
  const seen = new Set<string>();

  return {
    turnId,

    async snapshotFile(absPath: string): Promise<void> {
      if (seen.has(absPath)) return; // already snapshotted this turn
      seen.add(absPath);

      const key = encodePathKey(absPath);
      const snapshotPath = join(turnDir, key);

      // Create the turn dir on first use.
      await mkdir(turnDir, { recursive: true });

      // Check if snapshot already exists on disk (cross-process dedup).
      try {
        await stat(snapshotPath);
        return; // already written — first write wins, keep original pre-turn state
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        // ENOENT — proceed to write snapshot
      }

      // Read the file. If it does not exist, write the NEW_FILE_SENTINEL so
      // rewind knows to delete the file when undoing.
      let content: Buffer | string;
      try {
        content = await readFile(absPath);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        content = NEW_FILE_SENTINEL;
      }

      // Write the snapshot. If EEXIST (race with another process), ignore it —
      // the first writer wins.
      try {
        await writeFile(snapshotPath, content, { flag: 'wx' });
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Another process already wrote it — that's fine.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Turn-dir discovery (for rewindFiles)
// ---------------------------------------------------------------------------

/**
 * List the snapshot entries in a given turn dir.
 * Returns an array of `{ absPath, snapshotPath, isNewFile }` for each entry.
 * Returns `[]` if the turn dir does not exist.
 *
 * `_stateDir` is used by tests to override the state directory.
 * @internal
 */
export function listTurnSnapshots(
  sessionId: string,
  turnId: string,
  _stateDir?: string,
): Array<{ absPath: string; snapshotPath: string; isNewFile: boolean }> {
  const turnDir = _stateDir
    ? join(_stateDir, 'file-checkpoints', sessionId, turnId)
    : getFileCheckpointTurnDir(sessionId, turnId);
  if (!existsSync(turnDir)) return [];

  const entries = readdirSync(turnDir, { withFileTypes: true });

  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      const snapshotPath = join(turnDir, e.name);
      const absPath = decodePathKey(e.name);
      const raw = readFileSync(snapshotPath, 'utf8');
      return {
        absPath,
        snapshotPath,
        isNewFile: raw === NEW_FILE_SENTINEL,
      };
    });
}
