/**
 * Shared `rewindFiles` implementation used by both provider query objects
 * (anthropic-direct and openai-compatible).
 *
 * Restores each file that was mutated during a given user turn to the state
 * captured by the FileCheckpointRegistry before the first tool call in that
 * turn. Files that did not exist before the turn (sentinel) are deleted.
 *
 * Bash-made file mutations are NOT tracked and therefore NOT restored.
 * This is documented behaviour — only write_file, edit_file, and patch_apply
 * calls are captured.
 *
 * @module agent/file-checkpoint/rewind-files
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ProviderRewindResult } from '../provider.js';
import { listTurnSnapshots } from './file-checkpoint.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RewindFilesDeps {
  /** The session id whose checkpoints to restore. */
  sessionId: string;
  /** Whether file checkpointing is enabled on this session. */
  enableFileCheckpointing: boolean;
  /**
   * Override the AFK state directory (for testing only).
   * @internal
   */
  _stateDir?: string;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Restore files to their pre-turn state for the given `turnId`.
 *
 * - When `enableFileCheckpointing` is false → `{ canRewind: false }`.
 * - When no checkpoint exists for `turnId` → `{ canRewind: false }`.
 * - When `dryRun` is true → list what would change without touching the FS.
 * - Otherwise restore each snapshotted path and return changed-file info.
 */
export async function rewindFiles(
  deps: RewindFilesDeps,
  turnId: string,
  options?: { dryRun?: boolean },
): Promise<ProviderRewindResult> {
  const { sessionId, enableFileCheckpointing } = deps;

  if (!enableFileCheckpointing) {
    return {
      canRewind: false,
      error: 'File checkpointing is not enabled (set enableFileCheckpointing: true in AgentConfig).',
    };
  }

  const snapshots = listTurnSnapshots(sessionId, turnId, deps._stateDir);

  if (snapshots.length === 0) {
    return {
      canRewind: false,
      error: `No file checkpoint found for turn ${JSON.stringify(turnId)}.`,
    };
  }

  const changedFiles: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const { absPath, snapshotPath, isNewFile } of snapshots) {
    if (options?.dryRun) {
      changedFiles.push(absPath);
      continue;
    }

    if (isNewFile) {
      // The file did not exist before this turn — delete it to undo.
      if (existsSync(absPath)) {
        unlinkSync(absPath);
        changedFiles.push(absPath);
        deletions += 1;
      }
    } else {
      // Restore the pre-edit content.
      const prior = readFileSync(snapshotPath);
      const currentExists = existsSync(absPath);
      const currentContent = currentExists ? readFileSync(absPath) : null;

      // Compute line diff stats for the result (best-effort).
      const priorLines = prior.toString('utf8').split('\n').length;
      const currentLines = currentContent ? currentContent.toString('utf8').split('\n').length : 0;
      const lineDelta = priorLines - currentLines;
      if (lineDelta > 0) insertions += lineDelta;
      else deletions += Math.abs(lineDelta);

      // Ensure parent directory exists (in case the file was deleted
      // by a downstream mutation after the snapshot).
      const parentDir = dirname(absPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(absPath, prior);
      changedFiles.push(absPath);
    }
  }

  if (options?.dryRun) {
    return {
      canRewind: true,
      filesChanged: changedFiles,
    };
  }

  return {
    canRewind: true,
    filesChanged: changedFiles,
    insertions,
    deletions,
  };
}
