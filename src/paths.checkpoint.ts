/**
 * Path helpers for the file-checkpoint feature.
 *
 * Checkpoints live under:
 *   `<stateDir>/file-checkpoints/<sessionId>/<turnId>/`
 *
 * Each SHA-256 digest-named entry directory contains binary pre-edit content
 * and metadata recording the original absolute path, existence and mode.
 * Content and metadata are published together with an atomic directory rename.
 * Readers retain compatibility with legacy base64url-named snapshots.
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
 * Entries inside are named `<sha256(absPath)>.entry` and hold `content`
 * and `metadata.json`; `.pending-*` directories are not restorable.
 */
export function getFileCheckpointTurnDir(
  sessionId: string,
  turnId: string,
): string {
  return join(getFileCheckpointSessionDir(sessionId), turnId);
}
