/** Restore tracked tool mutations using current write grants and atomic writes. */
import { readFileSync, unlinkSync, lstatSync } from 'node:fs';
import type { ProviderRewindResult } from '../provider.js';
import type { ToolHandlerContext } from '../tools/types.js';
import { listTurnSnapshots, type FileSnapshot } from './file-checkpoint.js';
import { validatedWriteTarget } from './write-policy.js';
import { resolveAndContain, realpathSafe } from '../tools/handlers/_cwd-utils.js';
import { assertNotDenylisted } from '../tools/handlers/write-denylist.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import { errorMessage } from '../../utils/errors.js';

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
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
  try { snapshots = listTurnSnapshots(deps.sessionId, turnId, deps._stateDir); }
  catch (err) { return { canRewind: false, error: `Cannot read checkpoint: ${errorMessage(err)}`, filesChanged: [] }; }
  if (!snapshots.length) return { canRewind: false, error: `No file checkpoint found for turn ${JSON.stringify(turnId)}.` };

  const changedFiles: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const { absPath, snapshotPath, isNewFile, mode } of snapshots) {
    try {
      // Invariant: validate the actual current destination BEFORE reading it or
      // creating directories; stored paths never grant historical permissions.
      const target = await validatedWriteTarget(absPath, deps.writePolicy);
      const current = currentBytes(target);
      const prior = isNewFile ? null : readFileSync(snapshotPath);
      if (isNewFile ? current === null : current?.equals(prior!)) continue;
      if (options?.dryRun) { changedFiles.push(absPath); continue; }
      if (isNewFile) {
        assertDestination(absPath, target, deps.writePolicy);
        // Delete only a regular tracked target, never a retargeted link.
        if (lstatSync(target).isSymbolicLink()) throw new Error(`Refusing to delete symlink: ${target}`);
        unlinkSync(target);
        deletions += 1;
      } else {
        await atomicWriteFileAsync(target, prior!, {
          secure: true, mkdirp: true, ...(mode !== undefined ? { mode, exactMode: true } : {}),
          // Invariant: policy validation and rename share an event-loop tick.
          commitGuard: () => { assertDestination(absPath, target, deps.writePolicy); return true; },
        });
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
