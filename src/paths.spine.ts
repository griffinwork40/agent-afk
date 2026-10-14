import { join } from 'path';
import { getAfkStateDir } from './paths.js';

/**
 * Path to the per-worktree diff-fingerprint map for the SPINE SessionEnd hook.
 *
 * The hook writes a SHA-256 hex digest of the diff it classified into a JSON
 * map keyed by a short hash of the worktree root. Using a single shared slot,
 * or one slot keyed by a shared git common-dir root, lets linked worktrees evict
 * each other's fingerprints and re-trigger paid classification calls.
 *
 * Lives at `$AFK_STATE_DIR/spine-diff-fingerprints.json`.
 */
export function getSpineDiffFingerprintPath(): string {
  return join(getAfkStateDir(), 'spine-diff-fingerprints.json');
}
