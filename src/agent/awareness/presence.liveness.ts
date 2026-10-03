/**
 * Display-side liveness verification for presence records.
 *
 * `readPresenceFiles()` annotates each record with `kill(pid, 0)` liveness, and
 * that alone has a hole: the OS recycles pids, so a record whose owner was
 * SIGKILLed hours ago reads `'alive'` again as soon as an unrelated process
 * inherits its pid. `list_sessions`, `/peers`, the Telegram watcher and the
 * web dashboard then advertise sessions that ended long ago.
 *
 * This module closes the hole for DISPLAY and ROUTING consumers only. It never
 * changes `readPresenceFiles()`. Invariant: a DESTRUCTIVE consumer (worktree
 * sweep, peer-inbox sweep, presence reaper) must build its protected set from
 * raw `readPresenceFiles()` filtered only on `liveness !== 'dead'`, never from
 * this filter: a hidden record can still be a running session (a probe can be
 * wrong, a legacy build can still be up), and a false "gone" there deletes
 * that session's worktree or unread inbox.
 *
 * Verdicts (see {@link classifyPresenceRecord}):
 *   - `'dead'`    pid not running (`kill` → ESRCH). Hidden.
 *   - `'reused'`  the record's start identity disagrees with what the OS
 *                 reports for that pid today. Same pid, different process.
 *                 Hidden. When both sides carry Linux `starttime` ticks
 *                 (`pidStartTicks`), ticks are compared exactly: they are fixed
 *                 for the life of a process and immune to wall-clock steps,
 *                 unlike the Linux epoch derived from `btime`. Otherwise the
 *                 epoch `pidStartedAt` is compared with
 *                 {@link START_TIME_TOLERANCE_MS} of slack (darwin's `ps etime`
 *                 is relative to the kernel's wall-clock start stamp, so a clock
 *                 step moves both sides together).
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
import { probeProcessStartTimes, type ProcessStartInfo } from '../process-liveness.start-time.js';

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

/** Batched pid → OS start identity (undefined = unknown). */
export type StartTimeProbe = (pids: readonly number[]) => Promise<Map<number, ProcessStartInfo | undefined>>;

type IdentityFields = Pick<PresenceRecord, 'liveness' | 'heartbeatAgeMs' | 'pidStartedAt' | 'pidStartTicks'>;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** True when the record carries any start identity a probe can be compared to. */
function hasStartIdentity(record: Pick<PresenceRecord, 'pidStartedAt' | 'pidStartTicks'>): boolean {
  return isFiniteNumber(record.pidStartedAt) || isFiniteNumber(record.pidStartTicks);
}

/**
 * Classify one record given what the OS reports for its pid (`undefined` when
 * unknown). Pure; see the module header for the rules.
 */
export function classifyPresenceRecord(
  record: IdentityFields,
  probed: ProcessStartInfo | undefined,
): PresenceVerdict {
  if (record.liveness === 'dead') return 'dead';
  if (hasStartIdentity(record)) {
    if (isFiniteNumber(record.pidStartTicks) && isFiniteNumber(probed?.startTicks)) {
      return record.pidStartTicks === probed.startTicks ? 'live' : 'reused';
    }
    if (
      isFiniteNumber(record.pidStartedAt) &&
      isFiniteNumber(probed?.startedAtMs) &&
      Math.abs(probed.startedAtMs - record.pidStartedAt) > START_TIME_TOLERANCE_MS
    ) {
      return 'reused';
    }
    return 'live';
  }
  if (record.heartbeatAgeMs !== null && record.heartbeatAgeMs >= LEGACY_STALE_HEARTBEAT_MS) {
    return 'stale-legacy';
  }
  return 'live';
}

/** How long a successful probe result is reused for the same record identity. */
export const START_TIME_PROBE_CACHE_TTL_MS = 30_000;

/**
 * Short-lived cache of probe results keyed by `(pid, recorded identity)`.
 * Exists because the Telegram auto-subscribe loop reads live presence every 5s,
 * and on macOS each uncached read spawns `ps`. Unknown results are never
 * cached, so a transient probe failure is retried on the next read. Liveness
 * (`kill(pid, 0)`) is NOT cached: a dead pid is still hidden immediately.
 */
export class StartTimeProbeCache {
  private readonly entries = new Map<string, { at: number; info: ProcessStartInfo }>();

  constructor(
    private readonly ttlMs: number = START_TIME_PROBE_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  static keyFor(record: Pick<PresenceRecord, 'pid' | 'pidStartedAt' | 'pidStartTicks'>): string {
    return `${record.pid}:${String(record.pidStartedAt)}:${String(record.pidStartTicks)}`;
  }

  get(key: string): ProcessStartInfo | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.info;
  }

  set(key: string, info: ProcessStartInfo): void {
    const at = this.now();
    // Prune on write so the map stays bounded by the live record set.
    for (const [k, v] of this.entries) if (at - v.at >= this.ttlMs) this.entries.delete(k);
    this.entries.set(key, { at, info });
  }

  clear(): void {
    this.entries.clear();
  }
}

// Single owner of the process-wide probe cache. Used only when the caller does
// not inject its own probe, so tests that inject a probe never see stale hits.
const sharedProbeCache = new StartTimeProbeCache();

/** Test-only: drop every cached probe result. */
export function _resetStartTimeProbeCacheForTest(): void {
  sharedProbeCache.clear();
}

const defaultProbe: StartTimeProbe = (pids) => probeProcessStartTimes(pids);

/** Resolve probe results for `records`, serving cache hits and probing the rest once. */
async function resolveStarts(
  records: PresenceRecord[],
  probe: StartTimeProbe,
  cache: StartTimeProbeCache | undefined,
): Promise<Map<PresenceRecord, ProcessStartInfo | undefined>> {
  const out = new Map<PresenceRecord, ProcessStartInfo | undefined>();
  const misses: PresenceRecord[] = [];
  for (const r of records) {
    const hit = cache?.get(StartTimeProbeCache.keyFor(r));
    if (hit !== undefined) out.set(r, hit);
    else misses.push(r);
  }
  if (misses.length === 0) return out;
  let probed = new Map<number, ProcessStartInfo | undefined>();
  try {
    probed = await probe(misses.map((r) => r.pid));
  } catch {
    // Unknown for all — classification keeps them.
  }
  for (const r of misses) {
    const info = probed.get(r.pid);
    out.set(r, info);
    if (info !== undefined) cache?.set(StartTimeProbeCache.keyFor(r), info);
  }
  return out;
}

/**
 * Keep only records whose verdict is `'live'`. Probes start identities once,
 * in a single batch, and only for records that carry one (legacy records have
 * nothing to compare against). Never throws: a failing probe leaves every
 * identity unknown, which keeps the record. With no injected `probe`, results
 * are served from the process-wide {@link StartTimeProbeCache}.
 */
export async function filterVerifiedLive(
  records: PresenceRecord[],
  probe?: StartTimeProbe,
  cache?: StartTimeProbeCache,
): Promise<PresenceRecord[]> {
  const effectiveCache = cache ?? (probe === undefined ? sharedProbeCache : undefined);
  const toProbe = records.filter((r) => r.liveness !== 'dead' && hasStartIdentity(r));
  const starts = await resolveStarts(toProbe, probe ?? defaultProbe, effectiveCache);
  return records.filter((r) => classifyPresenceRecord(r, starts.get(r)) === 'live');
}
