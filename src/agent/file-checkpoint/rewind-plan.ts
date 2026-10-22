/**
 * Cross-turn rewind planning (#4271): which snapshot to restore per path.
 *
 * Rewinding to turn N must undo every later turn too, not only the paths N
 * itself touched. The plan folds the snapshots of every turn logged at or after
 * N (see `turn-log.ts` for why that suffix is correct) and keeps the EARLIEST
 * snapshot per path: the bytes that path held just before the first turn in
 * the suffix wrote it, which is its state at the start of turn N. Each path is
 * then written exactly once, never through intermediate states.
 *
 * A turn missing from the log (checkpoints written before the log existed)
 * falls back to that single turn's snapshots, the pre-#4271 behaviour.
 *
 * @module agent/file-checkpoint/rewind-plan
 */

import { hasTurnCheckpoint, listTurnSnapshots, type FileSnapshot } from './file-checkpoint.js';
import { expectedHashes, readTurnLog, turnsFrom } from './turn-log.js';

export interface RewindPlan {
  /** One snapshot per path, the earliest in the folded suffix. */
  snapshots: FileSnapshot[];
  /** Latest recorded on-disk hash per path, for the drift guard. Empty for legacy turns. */
  expected: Map<string, string | null>;
}

export type RewindPlanResult = { plan: RewindPlan } | { missing: true };

export function planRewind(sessionId: string, turnId: string, stateDir?: string): RewindPlanResult {
  const log = readTurnLog(sessionId, stateDir);
  const suffix = turnsFrom(log, turnId);
  if (suffix === undefined) {
    if (!hasTurnCheckpoint(sessionId, turnId, stateDir)) return { missing: true };
    return { plan: { snapshots: listTurnSnapshots(sessionId, turnId, stateDir), expected: new Map() } };
  }
  const earliest = new Map<string, FileSnapshot>();
  for (const id of suffix) {
    for (const snapshot of listTurnSnapshots(sessionId, id, stateDir)) {
      if (!earliest.has(snapshot.absPath)) earliest.set(snapshot.absPath, snapshot);
    }
  }
  return { plan: { snapshots: [...earliest.values()], expected: expectedHashes(log) } };
}
