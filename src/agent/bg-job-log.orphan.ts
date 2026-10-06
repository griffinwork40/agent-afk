/**
 * Orphan detection for background-job meta records (#2304).
 *
 * Extracted from `bg-job-log.ts` to keep that file under the 350-code-line
 * ceiling. `bg-job-log.ts` re-exports `reconcileOrphanedMeta`, so importers
 * are unchanged. Type-only import of `BgJobMeta` avoids a runtime cycle.
 */

import { atomicWriteFileAsync } from '../utils/atomic-write.js';
import { classifyPidLiveness } from './process-liveness.js';
import {
  probeProcessStartTimes,
  ownProcessStartTicks,
} from './process-liveness.start-time.js';
import type { StartTimeProbeDeps } from './process-liveness.start-time.js';
import type { BgJobMeta } from './bg-job-log.js';

/** Injection seams for {@link reconcileOrphanedMeta} — used only in tests. */
export interface ReconcileOrphanDeps {
  /**
   * Override for {@link probeProcessStartTimes}. Receives the same `deps`
   * object so tests can inject a fake readFile / exec without wrapping the
   * whole probe.
   */
  probe?: (pids: readonly number[], deps?: StartTimeProbeDeps) => Promise<Map<number, { startedAtMs?: number; startTicks?: number } | undefined>>;
  /** Override the recorded own-process start ticks (Linux). */
  ownTicks?: () => number | undefined;
  /** Override the recorded own-process start epoch ms. */
  ownMs?: () => number;
}

/**
 * Whether `recorded` and `probed` represent the same process instance.
 *
 * Returns `false` (same process — treat as alive) when any identity check is
 * inconclusive (undefined probe result, undefined recorded value). This is the
 * fail-safe: when we cannot confirm a mismatch we must NOT promote to dead.
 *
 * Priority:
 *   1. `startTicks` (Linux only) — immune to wall-clock steps; preferred.
 *   2. `startedAtMs` with a 5-second tolerance — subject to NTP jitter and
 *      the `etime` parse precision of `ps` (1-second granularity).
 */
function isPidReused(
  recordedStartTime: number | undefined,
  probedInfo: { startedAtMs?: number; startTicks?: number } | undefined,
  ownTicks: number | undefined,
): boolean {
  if (probedInfo === undefined) return false; // probe could not determine start time → keep alive

  // Tick identity (Linux) — compare against own ticks when the meta was written
  // by the current process, and against the meta's own ownerStartTime otherwise
  // (which on Linux would be startTicks stored as ms … but ownerStartTime is
  // always epoch-ms in BgJobMeta). So for ticks we only have the own-process
  // comparison path. If the probed pid has ticks AND we know our own ticks:
  if (probedInfo.startTicks !== undefined && ownTicks !== undefined) {
    // The recorded ownerPid IS our own pid — compare ticks directly.
    return probedInfo.startTicks !== ownTicks;
  }

  // Wall-clock epoch ms comparison with 5-second tolerance.
  if (recordedStartTime !== undefined && probedInfo.startedAtMs !== undefined) {
    return Math.abs(probedInfo.startedAtMs - recordedStartTime) > 5_000;
  }

  // No usable identity — cannot confirm reuse → fail safe (keep alive).
  return false;
}

/**
 * If `meta` is still `running` but its owner PID is no longer alive (or has
 * been reused by a different process), return a copy promoted to `failed`
 * with `stopReason: 'owner-process-exited'`. Otherwise return `meta`
 * unchanged.
 *
 * This is an async reconciliation — it does NOT write to disk. Callers that
 * want to persist the correction should call `writeMeta` after receiving a
 * promoted result.
 *
 * `endedAt` is intentionally left absent on orphan-reconciled records:
 * the process exit time is unknown, so stamping the current read time
 * would inflate any durationMs calculation. Consumers must tolerate an
 * absent `endedAt` (the field is already optional in `BgJobMeta`).
 *
 * Liveness check delegates to `classifyPidLiveness` from `process-liveness.ts`,
 * which returns `'unknown'` for absent, non-integer, or out-of-range pids
 * (preserving backward compatibility with legacy meta that lacks `ownerPid`).
 * Only a verdict of `'dead'` triggers promotion; `'alive'` and `'unknown'`
 * both cause the meta to be returned unchanged.
 *
 * PID-reuse detection (fail-safe): when `kill(pid,0)` says the pid is alive,
 * `probeProcessStartTimes` is used to compare the probed start time against
 * `ownerStartTime` recorded in the meta. A confirmed mismatch (start-time
 * differs by more than 5 s, or Linux ticks differ) promotes the meta to
 * `failed`. When the probe cannot determine a start time (platform
 * unsupported, permission error, etc.) the existing `kill(pid,0)` verdict
 * is kept — the function always fails safe.
 *
 * @param deps — injection seams for tests (probe, ownTicks, ownMs). Production
 *   callers omit this parameter.
 */
export async function reconcileOrphanedMeta(
  meta: BgJobMeta,
  deps?: ReconcileOrphanDeps,
): Promise<BgJobMeta> {
  if (meta.status !== 'running') return meta;

  const liveness = classifyPidLiveness(meta.ownerPid);

  if (liveness === 'unknown') return meta; // no usable pid — keep unchanged

  if (liveness === 'dead') {
    // kill(pid,0) confirmed the process is gone.
    return { ...meta, status: 'failed', stopReason: 'owner-process-exited' };
  }

  // liveness === 'alive': pid exists, but could be a reused pid.
  // Run start-time probe only when ownerStartTime was recorded.
  if (meta.ownerPid === undefined || meta.ownerStartTime === undefined) return meta;

  const probe = deps?.probe ?? probeProcessStartTimes;
  const ownTicks = (deps?.ownTicks ?? ownProcessStartTicks)();
  // Only pass ownTicks when the alive pid IS our own pid — otherwise we have
  // no recorded ticks to compare against (ownerStartTime is always epoch-ms).
  const effectiveOwnTicks = meta.ownerPid === process.pid ? ownTicks : undefined;

  let probedMap: Map<number, { startedAtMs?: number; startTicks?: number } | undefined>;
  try {
    probedMap = await probe([meta.ownerPid]);
  } catch {
    // Probe threw unexpectedly — fail safe, keep alive.
    return meta;
  }

  const probedInfo = probedMap.get(meta.ownerPid);
  if (!isPidReused(meta.ownerStartTime, probedInfo, effectiveOwnTicks)) return meta;

  // Start time mismatch — the pid has been recycled by a different process.
  return { ...meta, status: 'failed', stopReason: 'owner-process-exited' };
}

/**
 * Fire-and-forget persist of a reconciled meta back to disk.
 * Swallows all errors — the reader already has the corrected in-memory copy,
 * so a write failure only means the next read will reconcile again.
 */
export function persistReconciled(metaPath: string, reconciled: BgJobMeta): void {
  atomicWriteFileAsync(metaPath, JSON.stringify(reconciled, null, 2)).catch(() => {
    /* best-effort — next read will re-reconcile */
  });
}
