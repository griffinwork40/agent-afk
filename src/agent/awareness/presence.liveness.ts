/**
 * Display-side liveness verification for presence records.
 *
 * `readPresenceFiles()` annotates each record with `kill(pid, 0)` liveness, and
 * that alone has a hole: the OS recycles pids, so a record whose owner was
 * SIGKILLed hours ago reads `'alive'` again as soon as an unrelated process
 * inherits its pid. `list_sessions`, `/peers`, the Telegram watcher and the
 * web dashboard then advertise sessions that ended long ago.
 *
 * This module closes the hole for DISPLAY consumers only. It never changes
 * `readPresenceFiles()`: the worktree sweep relies on seeing every record, and
 * a false "dead" there deletes a worktree under a running session.
 *
 * Verdicts (see {@link classifyPresenceRecord}):
 *   - `'dead'`    pid not running (`kill` → ESRCH). Hidden.
 *   - `'reused'`  record carries `pidStartedAt` and the OS reports a start time
 *                 for that pid more than {@link START_TIME_TOLERANCE_MS} away.
 *                 Same pid, different process. Hidden.
 *   - `'stale-legacy'` record has NO `pidStartedAt` (written by an afk build
 *                 that predates it) and its heartbeat is at least
 *                 {@link LEGACY_STALE_HEARTBEAT_MS} old. Those builds never
 *                 refreshed `heartbeatAt` after the initial write, so the
 *                 heartbeat is really "session started at". Hidden. Tradeoff:
 *                 a genuinely running session from an old build disappears
 *                 from listings after 6h; it reappears once it is restarted on
 *                 a current build.
 *   - `'live'`    everything else, INCLUDING records whose start time could not
 *                 be probed. Unknown never hides a session: showing a stale
 *                 entry is a smaller failure than hiding a live one.
 *
 * @module agent/awareness/presence.liveness
 */

import type { PresenceRecord } from './presence.js';
import { probeProcessStartTimes } from '../process-liveness.start-time.js';

/**
 * Allowed skew between the recorded and probed start time. `ps etime` and
 * Linux `btime` both have 1s resolution, and the recorded value is derived
 * from `Date.now() - process.uptime()`, so a few seconds of disagreement is
 * normal for the SAME process. A reused pid is virtually always minutes to
 * hours off.
 */
export const START_TIME_TOLERANCE_MS = 5_000;

/** Heartbeat age at which a legacy (no `pidStartedAt`) record is hidden. */
export const LEGACY_STALE_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

/** Display verdict for one presence record. */
export type PresenceVerdict = 'live' | 'dead' | 'reused' | 'stale-legacy';

/** Batched pid → OS start epoch ms (undefined = unknown). */
export type StartTimeProbe = (pids: readonly number[]) => Promise<Map<number, number | undefined>>;

/**
 * Classify one record given the OS-reported start time of its pid
 * (`undefined` when unknown). Pure; see the module header for the rules.
 */
export function classifyPresenceRecord(
  record: Pick<PresenceRecord, 'liveness' | 'heartbeatAgeMs' | 'pidStartedAt'>,
  probedStartMs: number | undefined,
): PresenceVerdict {
  if (record.liveness === 'dead') return 'dead';
  const recorded = record.pidStartedAt;
  if (typeof recorded === 'number' && Number.isFinite(recorded)) {
    if (probedStartMs !== undefined && Math.abs(probedStartMs - recorded) > START_TIME_TOLERANCE_MS) {
      return 'reused';
    }
    return 'live';
  }
  if (record.heartbeatAgeMs !== null && record.heartbeatAgeMs >= LEGACY_STALE_HEARTBEAT_MS) {
    return 'stale-legacy';
  }
  return 'live';
}

/**
 * Keep only records whose verdict is `'live'`. Probes start times once, in a
 * single batch, and only for records that carry `pidStartedAt` (legacy records
 * have nothing to compare against). Never throws: a failing probe leaves every
 * start time unknown, which keeps the record.
 */
export async function filterVerifiedLive(
  records: PresenceRecord[],
  probe: StartTimeProbe = (pids) => probeProcessStartTimes(pids),
): Promise<PresenceRecord[]> {
  const toProbe = records
    .filter((r) => r.liveness !== 'dead' && typeof r.pidStartedAt === 'number')
    .map((r) => r.pid);
  let starts = new Map<number, number | undefined>();
  if (toProbe.length > 0) {
    try {
      starts = await probe(toProbe);
    } catch {
      // Unknown for all — classification keeps them.
    }
  }
  return records.filter((r) => classifyPresenceRecord(r, starts.get(r.pid)) === 'live');
}
