/**
 * Orphan detection for background-job meta records (#2304).
 *
 * Extracted from `bg-job-log.ts` to keep that file under the 350-code-line
 * ceiling. `bg-job-log.ts` re-exports `reconcileOrphanedMeta`, so importers
 * are unchanged. Type-only import of `BgJobMeta` avoids a runtime cycle.
 */

import { atomicWriteFileAsync } from '../utils/atomic-write.js';
import { classifyPidLiveness } from './process-liveness.js';
import type { BgJobMeta } from './bg-job-log.js';

/**
 * If `meta` is still `running` but its owner PID is no longer alive,
 * return a copy promoted to `failed` with `stopReason: 'owner-process-exited'`.
 * Otherwise return `meta` unchanged.
 *
 * This is a pure, synchronous reconciliation — it does NOT write to disk.
 * Callers that want to persist the correction should call `writeMeta` after
 * receiving a promoted result.
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
 */
export function reconcileOrphanedMeta(meta: BgJobMeta): BgJobMeta {
  if (meta.status !== 'running') return meta;
  // ownerStartTime is recorded for future pid-reuse detection and is
  // intentionally unused in the current reconciliation logic.
  const liveness = classifyPidLiveness(meta.ownerPid);
  if (liveness !== 'dead') return meta;
  return {
    ...meta,
    status: 'failed',
    stopReason: 'owner-process-exited',
  };
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
