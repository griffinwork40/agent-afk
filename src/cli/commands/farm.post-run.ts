/**
 * Post-run phase for `afk farm`: escape check, scoring, summary, memory write,
 * and Telegram digest.
 *
 * Extracted from `runFarm` to keep that function under the 200-line ceiling.
 * All behaviour is identical to the original inline code — only the call site
 * changed. Each parameter is passed explicitly (no closure over runFarm locals).
 *
 * @module cli/commands/farm.post-run
 */

import { palette } from '../palette.js';
import {
  scoreBranch,
  writeScore,
} from '../../skills/score/index.js';
import { writeFarmFact } from '../../skills/score/memory-write.js';
import { sendFarmDigest } from '../../skills/score/digest.js';
import { setFarmMemoryFactId } from '../../agent/worktree.js';
import { errorMessage } from '../../utils/errors.js';
import { printSummary, type BranchResult } from './farm.summary.js';
import { FarmIsolationViolation } from './farm.escape-check.js';
import type { FarmManifest } from '../../agent/worktree.js';

export interface FarmPostRunOptions {
  task: string;
  sourceCwd: string;
  manifest: FarmManifest;
  baseSha: string;
  branchResults: BranchResult[];
  dirtyFiles: string[];
  startedAt: string;
  scoringEnabled: boolean;
  scoreTimeoutMs: number;
  memoryWriteEnabled: boolean;
  digestEnabled: boolean;
  // Injection seams for testing
  _scoreBranch?: typeof scoreBranch;
  _writeScore?: typeof writeScore;
  _writeFarmFact?: typeof writeFarmFact;
  _sendFarmDigest?: typeof sendFarmDigest;
  _setFarmMemoryFactId?: typeof setFarmMemoryFactId;
}

/**
 * Run the post-DAG phase of `afk farm`:
 *   1. Score successful branches (sequential, not parallel).
 *   2. Print the summary table.
 *   3. Write a farm-run fact to cross-session memory.
 *   4. Push a Telegram digest.
 *   5. Check for source-repo dirty files (isolation violation → exit 1).
 *   6. Exit with 0 (all ok) or 1 (any branch failed).
 *
 * Never returns normally — always calls `process.exit`. The caller is
 * responsible for catching errors from the DAG phase before invoking this.
 */
export async function runFarmPostRun(opts: FarmPostRunOptions): Promise<never> {
  const {
    task,
    manifest,
    baseSha,
    branchResults,
    dirtyFiles,
    startedAt,
    scoringEnabled,
    scoreTimeoutMs,
    memoryWriteEnabled,
    digestEnabled,
    _scoreBranch: scoreBranchFn = scoreBranch,
    _writeScore: writeScoreFn = writeScore,
    _writeFarmFact: writeFarmFactFn = writeFarmFact,
    _sendFarmDigest: sendFarmDigestFn = sendFarmDigest,
    _setFarmMemoryFactId: setFarmMemoryFactIdFn = setFarmMemoryFactId,
  } = opts;

  // -- Score successful branches (Day 3) --
  // Sequential (NOT parallel) — concurrent test runs across worktrees risk OOM.
  if (scoringEnabled) {
    for (const r of branchResults) {
      if (!r.ok) {
        r.score = null;
        continue;
      }
      const branch = manifest.branches.find((b) => b.index === r.index)!;
      console.log(`[branch-${r.index}] scoring…`);
      const score = await scoreBranchFn({
        branchPath: branch.path,
        baseSha,
        timeoutMs: scoreTimeoutMs,
      });
      r.score = score;
      try {
        await writeScoreFn(manifest.farmDir, r.index, score);
      } catch (err) {
        console.error(
          palette.warning(`[branch-${r.index}] score.json write failed: ${errorMessage(err)}`),
        );
      }
    }
  }

  // -- Print summary --
  printSummary(task, manifest.taskSlug, manifest.branches, branchResults);

  // -- Build FarmRunRecord and dispatch to memory + Telegram (Day 4) --
  if (memoryWriteEnabled || digestEnabled) {
    const { buildFarmRunRecord } = await import('./farm.run-record.js');
    const farmRecord = buildFarmRunRecord(manifest, branchResults, startedAt);
    if (memoryWriteEnabled) {
      const memResult = writeFarmFactFn(farmRecord);
      if ('skipped' in memResult) {
        console.error(palette.warning(`[memory] write skipped: ${memResult.reason}`));
      } else {
        const { factId } = memResult;
        try {
          await setFarmMemoryFactIdFn(manifest.taskSlug, factId);
        } catch (err) {
          console.error(palette.warning(`[memory] setFarmMemoryFactId failed: ${errorMessage(err)}`));
        }
      }
    }
    if (digestEnabled) {
      const digestResult = await sendFarmDigestFn(farmRecord);
      if (digestResult.sent) {
        console.log(
          palette.dim(
            `[telegram] digest sent (${digestResult.chatCount} chat${digestResult.chatCount === 1 ? '' : 's'})`,
          ),
        );
      } else if (digestResult.reason && digestResult.reason !== 'telegram unconfigured') {
        console.error(palette.warning(`[telegram] digest failed: ${digestResult.reason}`));
      }
    }
  }

  // -- Exit handling --
  if (dirtyFiles.length > 0) {
    const violation = new FarmIsolationViolation(dirtyFiles);
    console.error(palette.error('\n⚠  ISOLATION VIOLATION'));
    console.error(palette.error(violation.message));
    process.exit(1);
  }

  const allOk = branchResults.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

