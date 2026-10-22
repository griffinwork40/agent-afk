/**
 * Restore tracked tool mutations using current write grants and atomic writes.
 *
 * Contract (#4271): rewinding to a turn restores the state at the START of
 * that turn across every later turn (see `rewind-plan.ts`), and is
 * all-or-report: every path is attempted and each failure is returned in
 * `failures`, so a restore is never silently partial. Paths changed outside the
 * agent since the last recorded state are returned in `conflicts` and are only
 * overwritten with `overwriteConflicts`. Restore remains per-file, not
 * transactional: files already restored stay restored when another fails.
 */
import { readFileSync, unlinkSync, lstatSync } from 'node:fs';
import type { ProviderRewindResult, RewindFileFailure, RewindFilesOptions } from '../provider.js';
import type { ToolHandlerContext } from '../tools/types.js';
import type { FileSnapshot } from './file-checkpoint.js';
import { planRewind, type RewindPlan } from './rewind-plan.js';
import { appendTurnLog, hashBytes, type PathHashes } from './turn-log.js';
import { acquireRewindLock } from './retention.js';
import { validatedWriteTarget } from './write-policy.js';
import { resolveAndContain, realpathSafe } from '../tools/handlers/_cwd-utils.js';
import { assertNotDenylisted } from '../tools/handlers/write-denylist.js';
import { isAbsolute } from 'node:path';
import { pinRewindParent, stageRewindFile } from './rewind-staging.js';
import { errorMessage, isEnoent } from '../../utils/errors.js';
import { readCheckpointContent } from './content-store.js';

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

interface Tally {
  changed: string[];
  insertions: number;
  deletions: number;
  failures: RewindFileFailure[];
  conflicts: string[];
  /** Hash written per restored path, for the turn log's `restore` entry. */
  restored: PathHashes;
  /** Takes the retention lock on first use; see {@link rewindFiles}. */
  lock: () => void;
  /** Bash-capture warnings from the plan, passed through to the result. */
  uncaptured: string[];
}

/** Restore (or, on dry-run, assess) one path. Throws to record a per-path failure. */
async function restoreOne(
  deps: RewindFilesDeps, snapshot: FileSnapshot, expected: RewindPlan['expected'],
  options: RewindFilesOptions | undefined, tally: Tally,
): Promise<void> {
  const { absPath, isNewFile, mode } = snapshot;
  // Invariant: validate the actual current destination BEFORE reading it or
  // creating directories; stored paths never grant historical permissions.
  if (!isAbsolute(absPath)) throw new Error(`Checkpoint path must be absolute: ${absPath}`);
  const target = await validatedWriteTarget(absPath, deps.writePolicy);
  const current = currentBytes(target);
  const prior = isNewFile ? null : readCheckpointContent(snapshot);
  if (isNewFile ? current === null : current?.equals(prior!)) return;
  if (expected.has(absPath) && hashBytes(current) !== expected.get(absPath)) {
    tally.conflicts.push(absPath);
    if (!options?.dryRun && options?.overwriteConflicts !== true) {
      throw new Error('changed outside the agent since the last recorded state; not overwritten');
    }
  }
  if (options?.dryRun) { tally.changed.push(absPath); return; }
  tally.lock();
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
    tally.deletions += 1;
  } else {
    stageRewindFile(target, prior!, () => assertDestination(absPath, target, deps.writePolicy), mode);
    const delta = prior!.toString('utf8').split('\n').length - (current?.toString('utf8').split('\n').length ?? 0);
    if (delta > 0) tally.insertions += delta;
    else tally.deletions += Math.abs(delta);
  }
  tally.restored[absPath] = hashBytes(prior);
  tally.changed.push(absPath);
}

function summarize(tally: Tally, dryRun: boolean): ProviderRewindResult {
  const extras = {
    ...(tally.failures.length ? { failures: tally.failures } : {}),
    ...(tally.conflicts.length ? { conflicts: tally.conflicts } : {}),
    ...(tally.uncaptured.length ? { uncaptured: tally.uncaptured } : {}),
  };
  const counts = dryRun ? {} : { insertions: tally.insertions, deletions: tally.deletions };
  const first = tally.failures[0];
  if (first === undefined) return { canRewind: true, filesChanged: tally.changed, ...counts, ...extras };
  const more = tally.failures.length > 1 ? ` (+${tally.failures.length - 1} more failed)` : '';
  const verb = dryRun ? 'would fail' : 'failed';
  return {
    canRewind: false, filesChanged: tally.changed, ...counts, ...extras,
    error: `Rewind ${verb} at ${first.path}; ${tally.changed.length} file(s) ${dryRun ? 'would change' : 'already changed'}: ${first.error}${more}`,
  };
}

export async function rewindFiles(
  deps: RewindFilesDeps, turnId: string, options?: RewindFilesOptions,
): Promise<ProviderRewindResult> {
  if (!deps.enableFileCheckpointing) {
    return { canRewind: false, error: 'File checkpointing is not enabled (set enableFileCheckpointing: true in AgentConfig).' };
  }
  let plan: RewindPlan;
  try {
    const planned = planRewind(deps.sessionId, turnId, deps._stateDir);
    if ('missing' in planned) return { canRewind: false, error: `No file checkpoint found for turn ${JSON.stringify(turnId)}.` };
    plan = planned.plan;
  }
  catch (err) { return { canRewind: false, error: `Cannot read checkpoint: ${errorMessage(err)}`, filesChanged: [] }; }
  if (!plan.snapshots.length) {
    const base = { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 };
    return plan.uncaptured.length ? { ...base, uncaptured: plan.uncaptured } : base;
  }

  const dryRun = options?.dryRun === true;
  // Invariant: the retention lock is taken lazily, immediately before the
  // first mutation, so a rewind that refuses every path writes nothing at all.
  let release: (() => void) | undefined;
  const lock = (): void => { release ??= acquireRewindLock(deps.sessionId, deps._stateDir); };
  try {
    const tally: Tally = { changed: [], insertions: 0, deletions: 0, failures: [], conflicts: [], restored: {}, lock, uncaptured: plan.uncaptured };
    for (const snapshot of plan.snapshots) {
      try { await restoreOne(deps, snapshot, plan.expected, options, tally); }
      catch (err) { tally.failures.push({ path: snapshot.absPath, error: errorMessage(err) }); }
    }
    if (Object.keys(tally.restored).length > 0) {
      appendTurnLog(deps.sessionId, { kind: 'restore', paths: tally.restored, ts: Date.now() }, deps._stateDir);
    }
    return summarize(tally, dryRun);
  } finally {
    release?.();
  }
}
