/** Restore tracked tool mutations using current write grants and atomic writes. */
import { readFileSync, unlinkSync, lstatSync } from 'node:fs';
import type { ProviderRewindResult } from '../provider.js';
import type { ToolHandlerContext } from '../tools/types.js';
import { hasTurnCheckpoint, listTurnSnapshots, type FileSnapshot } from './file-checkpoint.js';
import { validatedWriteTarget } from './write-policy.js';
import { resolveAndContain, realpathSafe } from '../tools/handlers/_cwd-utils.js';
import { assertNotDenylisted } from '../tools/handlers/write-denylist.js';
import { isAbsolute } from 'node:path';
import { pinRewindParent, stageRewindFile } from './rewind-staging.js';
import { errorMessage, isEnoent } from '../../utils/errors.js';

export interface RewindFilesDeps {
  sessionId: string;
  enableFileCheckpointing: boolean;
  /** Fresh dispatcher grants supplied by the provider on every rewind. */
  writePolicy?: ToolHandlerContext;
  /** @internal Isolated state directory for tests. */
  _stateDir?: string;
}

function currentBytes(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch (err) {
    if (!isEnoent(err)) throw err;
    return null;
  }
}

function assertDestination(path: string, target: string, policy?: ToolHandlerContext): void {
  resolveAndContain(path, policy, 'write');
  assertNotDenylisted(path, 'rewindFiles');
  resolveAndContain(target, policy, 'write');
  assertNotDenylisted(target, 'rewindFiles');
  if (realpathSafe(path) !== target) throw new Error(`Rewind destination changed: ${path}`);
}

export async function rewindFiles(
  deps: RewindFilesDeps, turnId: string, options?: { dryRun?: boolean },
): Promise<ProviderRewindResult> {
  if (!deps.enableFileCheckpointing) {
    return { canRewind: false, error: 'File checkpointing is not enabled (set enableFileCheckpointing: true in AgentConfig).' };
  }
  let snapshots: FileSnapshot[];
  try {
    if (!hasTurnCheckpoint(deps.sessionId, turnId, deps._stateDir)) {
      return { canRewind: false, error: `No file checkpoint found for turn ${JSON.stringify(turnId)}.` };
    }
    snapshots = listTurnSnapshots(deps.sessionId, turnId, deps._stateDir);
  }
  catch (err) { return { canRewind: false, error: `Cannot read checkpoint: ${errorMessage(err)}`, filesChanged: [] }; }
  if (!snapshots.length) return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 };

  const changedFiles: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const { absPath, snapshotPath, isNewFile, mode } of snapshots) {
    try {
      // Invariant: validate the actual current destination BEFORE reading it or
      // creating directories; stored paths never grant historical permissions.
      if (!isAbsolute(absPath)) throw new Error(`Checkpoint path must be absolute: ${absPath}`);
      const target = await validatedWriteTarget(absPath, deps.writePolicy);
      const current = currentBytes(target);
      const prior = isNewFile ? null : readFileSync(snapshotPath);
      if (isNewFile ? current === null : current?.equals(prior!)) continue;
      if (options?.dryRun) { changedFiles.push(absPath); continue; }
      if (isNewFile) {
        const guardParent = pinRewindParent(target);
        const saved = lstatSync(target);
        if (!saved.isFile()) throw new Error(`Refusing to delete non-regular file: ${target}`);
        assertDestination(absPath, target, deps.writePolicy);
        guardParent();
        // Like staging, pin before validation and recheck synchronously before
        // mutation. Node cannot eliminate external OS races after this check.
        const now = lstatSync(target);
        if (!now.isFile() || now.dev !== saved.dev || now.ino !== saved.ino) {
          throw new Error(`Rewind destination identity changed: ${target}`);
        }
        unlinkSync(target);
        deletions += 1;
      } else {
        stageRewindFile(target, prior!, () => assertDestination(absPath, target, deps.writePolicy), mode);
        const delta = prior!.toString('utf8').split('\n').length - (current?.toString('utf8').split('\n').length ?? 0);
        if (delta > 0) insertions += delta;
        else deletions += Math.abs(delta);
      }
      changedFiles.push(absPath);
    } catch (err) {
      return {
        canRewind: false, filesChanged: changedFiles, insertions, deletions,
        error: `Rewind failed at ${absPath}; ${changedFiles.length} file(s) already changed: ${errorMessage(err)}`,
      };
    }
  }
  return options?.dryRun ? { canRewind: true, filesChanged: changedFiles }
    : { canRewind: true, filesChanged: changedFiles, insertions, deletions };
}
