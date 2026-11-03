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
import { expectedHashes, readTurnLog, turnsFrom, type BashLogEntry } from './turn-log.js';

export interface RewindPlan {
  /** One snapshot per path, the earliest in the folded suffix. */
  snapshots: FileSnapshot[];
  /** Latest recorded on-disk hash per path, for the drift guard. Empty for legacy turns. */
  expected: Map<string, string | null>;
  /**
   * Human-readable warnings for bash calls in the folded suffix whose effects
   * were not fully captured. Empty array = no bash ran in this range.
   * Collected from `bash` log entries with status `partial` or `skipped`, plus
   * a standing warning when ANY `bash` entry exists in the range.
   */
  uncaptured: string[];
}

export type RewindPlanResult = { plan: RewindPlan } | { missing: true };

/**
 * Collect human-readable warnings from bash log entries in `suffix` turns.
 *
 * Contract: one warning per non-captured bash call (skipped or partial).
 * The standing advisory about git-ignored files and external side-effects is
 * appended only when at least one such per-call warning exists, because an
 * all-captured range has no uncaptured effects to disclaim. An explicit user
 * decision to rewind despite knowing bash ran overrides the concern — no
 * general advisory is emitted for fully-captured bash calls.
 */
function collectBashWarnings(log: ReturnType<typeof readTurnLog>, suffix: readonly string[]): string[] {
  const suffixSet = new Set(suffix);
  const bashEntries = log.filter((e): e is BashLogEntry => e.kind === 'bash' && suffixSet.has(e.turnId));
  if (bashEntries.length === 0) return [];

  const warnings: string[] = [];
  for (const entry of bashEntries) {
    if (entry.status === 'skipped') {
      const msg = entry.reason
        ? `Bash call in turn ${entry.turnId} was not captured: ${entry.reason}`
        : `Bash call in turn ${entry.turnId} was skipped (background job, subagent, or BASH_DISABLE).`;
      warnings.push(msg);
    } else if (entry.status === 'partial') {
      const msg = entry.reason
        ? `Bash call in turn ${entry.turnId} was only partially captured: ${entry.reason}`
        : `Bash call in turn ${entry.turnId} was only partially captured (detached or aborted mid-run).`;
      warnings.push(msg);
    }
    // `captured` with files > 0 is fully handled; no per-call warning needed.
  }
  // Append the standing advisory only when there are per-call warnings — i.e.
  // when at least one bash call was not fully captured. A fully-captured range
  // has no shell side-effects left unaccounted for, so the advisory would be
  // misleading noise and is omitted.
  if (warnings.length > 0) {
    warnings.push(
      'Bash changes to git-ignored files or files outside the repo are not restorable. ' +
      'External side-effects (such as network calls) are not undone by this restore.',
    );
  }
  return warnings;
}

export function planRewind(sessionId: string, turnId: string, stateDir?: string): RewindPlanResult {
  const log = readTurnLog(sessionId, stateDir);
  const suffix = turnsFrom(log, turnId);
  if (suffix === undefined) {
    if (!hasTurnCheckpoint(sessionId, turnId, stateDir)) return { missing: true };
    return { plan: { snapshots: listTurnSnapshots(sessionId, turnId, stateDir), expected: new Map(), uncaptured: [] } };
  }
  const earliest = new Map<string, FileSnapshot>();
  for (const id of suffix) {
    for (const snapshot of listTurnSnapshots(sessionId, id, stateDir)) {
      if (!earliest.has(snapshot.absPath)) earliest.set(snapshot.absPath, snapshot);
    }
  }
  const uncaptured = collectBashWarnings(log, suffix);
  return { plan: { snapshots: [...earliest.values()], expected: expectedHashes(log), uncaptured } };
}
