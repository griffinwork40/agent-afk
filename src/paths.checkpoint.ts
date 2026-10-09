/**
 * Path helpers for the file-checkpoint feature.
 *
 * Checkpoints live under:
 *   `<stateDir>/file-checkpoints/<sessionId>/<turnId>/`
 *
 * Each file in a turn dir is named with the base64url encoding of the
 * snapshotted file's absolute path, and contains either the pre-edit file
 * content (binary) or the NEW_FILE_SENTINEL string (when the file did not
 * exist before that turn).
 *
 * @module paths.checkpoint
 */

import { join } from 'path';
import { getAfkStateDir } from './paths.js';

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/** Root directory for all file-checkpoint data. */
export function getFileCheckpointsRoot(): string {
  return join(getAfkStateDir(), 'file-checkpoints');
}

// ---------------------------------------------------------------------------
// Per-session
// ---------------------------------------------------------------------------

/**
 * Directory holding all turn-checkpoint subdirs for one session.
 * `<stateDir>/file-checkpoints/<sessionId>/`
 */
export function getFileCheckpointSessionDir(sessionId: string): string {
  return join(getFileCheckpointsRoot(), sessionId);
}

// ---------------------------------------------------------------------------
// Per-turn
// ---------------------------------------------------------------------------

/**
 * Directory that holds snapshots for ONE user turn.
 * `<stateDir>/file-checkpoints/<sessionId>/<turnId>/`
 *
 * Files inside are named `encodePathKey(absPath)` (base64url of the
 * absolute path) and contain the pre-edit file content (or the
 * NEW_FILE_SENTINEL if the file did not exist before the turn).
 */
export function getFileCheckpointTurnDir(
  sessionId: string,
  turnId: string,
): string {
  return join(getFileCheckpointSessionDir(sessionId), turnId);
}
