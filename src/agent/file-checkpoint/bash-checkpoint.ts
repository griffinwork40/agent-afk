/** Best-effort, bounded foreground bash file capture (#4271 stage 2). */
import { env } from '../../config/env.js';
import { getFileCheckpointGitObjectDir, getFileCheckpointGitIndexPath } from '../../paths.js';
import type { FileCheckpointRegistry } from './file-checkpoint.js';
import { captureWorkspaceTree, diffTrees } from './git-snapshot.js';
import type { CaptureResult, CaptureOptions } from './git-snapshot.js';
import { appendTurnLog } from './turn-log.js';

export interface BashCheckpoint {
  /** Idempotent: detach and close can race, but publish only one outcome. */
  finish(partialReason?: string): Promise<void>;
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

/** Contract: even a broken snapshot implementation cannot hold the bash result forever. */
async function bounded<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function failureReason(error: unknown): string {
  return error instanceof Error && ['timeout', 'aborted'].includes(error.message) ? error.message : 'error';
}

// Invariant: a slow private index must not impose the same blocking timeout on
// every bash call. Disable capture for that session index for this process.
const timedOutIndexes = new Set<string>();
const disabledTimeoutReason = 'timeout (capture disabled for this session after a slow first snapshot)';

async function capture(options: CaptureOptions, signal?: AbortSignal): Promise<CaptureResult> {
  let result: CaptureResult;
  try {
    result = await bounded(() => {
      if (signal?.aborted) throw new Error('aborted');
      return captureWorkspaceTree(options);
    }, options.timeoutMs);
  } catch (error) { result = { ok: false, reason: failureReason(error) === 'timeout' ? 'timeout' : 'error' }; }
  if (!result.ok && result.reason === 'timeout') timedOutIndexes.add(options.indexFile);
  return result;
}

function partialReason(result: CaptureResult): string[] {
  return result.ok && 'partial' in result && typeof result.partial === 'string' ? [result.partial] : [];
}

export async function beginBashCheckpoint(
  registry: FileCheckpointRegistry | undefined, cwd: string, skipReason?: string, signal?: AbortSignal,
): Promise<BashCheckpoint> {
  try { return await prepareBashCheckpoint(registry, cwd, skipReason, signal); }
  catch {
    if (registry) appendTurnLog(registry.sessionId, {
      kind: 'bash', turnId: registry.turnId, status: 'skipped', reason: 'error', ts: Date.now(),
    }, registry.stateDir);
    return { finish: async () => {} };
  }
}

async function prepareBashCheckpoint(
  registry: FileCheckpointRegistry | undefined, cwd: string, skipReason?: string, signal?: AbortSignal,
): Promise<BashCheckpoint> {
  if (!registry) return { finish: async () => {} };
  const log = (status: 'captured' | 'partial' | 'skipped', reason?: string, files?: number) => {
    appendTurnLog(registry.sessionId, {
      kind: 'bash', turnId: registry.turnId, status, reason, files, ts: Date.now(),
    }, registry.stateDir);
  };
  const disabled = ['1', 'true'].includes(env.AFK_FILE_CHECKPOINT_BASH_DISABLE ?? '');
  if (signal?.aborted || skipReason || disabled) {
    log('skipped', signal?.aborted ? 'aborted before spawn' : skipReason ?? 'disabled');
    return { finish: async () => {} };
  }
  const timeoutMs = positive(env.AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS, 5000);
  const maxFiles = positive(env.AFK_FILE_CHECKPOINT_BASH_MAX_FILES, 1000);
  const options: CaptureOptions = {
    cwd, timeoutMs,
    objectDir: getFileCheckpointGitObjectDir(registry.sessionId, registry.stateDir),
    indexFile: getFileCheckpointGitIndexPath(registry.sessionId, registry.stateDir),
  };
  if (timedOutIndexes.has(options.indexFile)) {
    log('skipped', disabledTimeoutReason);
    return { finish: async () => {} };
  }
  const before = await capture(options, signal);
  if (signal?.aborted) {
    log('skipped', 'aborted before spawn');
    return { finish: async () => {} };
  }
  if (!before.ok) {
    log('skipped', before.reason);
    return { finish: async () => {} };
  }
  const baseline = before;
  let finished: Promise<void> | undefined;
  // Invariant: once the command has spawned, the after-snapshot runs even when
  // the call was aborted. A command interrupted mid-run (a stray `rm`) may
  // already have changed files, and that is when a rewind matters most; the
  // capture stays bounded by timeoutMs. Only a call that never spawned skips.
  async function finish(reason?: string): Promise<void> {
    let files = 0;
    const reasons = [...partialReason(baseline), ...(reason ? [reason] : [])];
    if (reason === 'aborted before spawn') {
      log('skipped', reason);
      return;
    }
    try {
      // Invariant: capture and publish complete before returning the tool result,
      // so endCheckpointTurn sees every successfully published bash path.
      const after = await capture(options);
      if (!after.ok) { log('skipped', [...reasons, after.reason].join('; ')); return; }
      if (after.repoRoot !== baseline.repoRoot) { log('skipped', 'repository changed'); return; }
      reasons.push(...partialReason(after));
      const diff = await bounded(() => diffTrees({
        repoRoot: baseline.repoRoot, objectDir: options.objectDir, before: baseline.tree,
        after: after.tree, maxFiles, timeoutMs,
      }), timeoutMs);
      if (!diff.ok) { log('skipped', [...reasons, diff.reason].join('; ')); return; }
      if (diff.truncated) reasons.push(`truncated at ${maxFiles} files`);
      if (diff.skipped.length) reasons.push(`symlinks or non-regular files skipped (${diff.skipped.length})`);
      const deadline = Date.now() + timeoutMs;
      // Invariant: never race local publication against a timer. A write already
      // in flight must settle before endCheckpointTurn hashes touchedPaths.
      for (const change of diff.changes) {
        if (Date.now() >= deadline) throw new Error('timeout');
        await registry!.recordPriorState(change.absPath, change.prior);
        files++;
      }
      log(reasons.length ? 'partial' : 'captured', reasons.length ? reasons.join('; ') : undefined, files);
    } catch (error) {
      log('partial', [...reasons, failureReason(error)].join('; '), files);
    }
  }
  return { finish: (reason) => finished ??= finish(reason) };
}
