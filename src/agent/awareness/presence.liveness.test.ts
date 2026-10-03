/**
 * Tests for display-side presence liveness: pid-reuse detection, unknown-probe
 * retention, and legacy-record heartbeat staleness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  classifyPresenceRecord,
  filterVerifiedLive,
  StartTimeProbeCache,
  _resetStartTimeProbeCacheForTest,
  LEGACY_STALE_HEARTBEAT_MS,
  START_TIME_TOLERANCE_MS,
  START_TIME_PROBE_CACHE_TTL_MS,
} from './presence.liveness.js';
import type { ProcessStartInfo } from '../process-liveness.start-time.js';

const at = (ms: number): ProcessStartInfo => ({ startedAtMs: ms });
import type { PresenceRecord } from './presence.js';

const T0 = 1_700_000_000_000;

function rec(overrides: Partial<PresenceRecord>): PresenceRecord {
  return {
    sessionId: 's',
    surface: 'cli',
    cwd: '/tmp',
    startedAt: new Date(T0).toISOString(),
    model: { provider: 'p', name: 'm' },
    workspace: { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null },
    pid: 4242,
    path: '/tmp/s.json',
    liveness: 'alive',
    heartbeatAgeMs: 1_000,
    ...overrides,
  };
}

describe('classifyPresenceRecord', () => {
  it('dead pid → dead', () => {
    expect(classifyPresenceRecord(rec({ liveness: 'dead' }), undefined)).toBe('dead');
  });
  it('start-time mismatch beyond tolerance → reused', () => {
    const r = rec({ pidStartedAt: T0 });
    expect(classifyPresenceRecord(r, at(T0 + START_TIME_TOLERANCE_MS + 1))).toBe('reused');
    expect(classifyPresenceRecord(r, at(T0 - 3_600_000))).toBe('reused');
  });
  it('start-time within tolerance → live', () => {
    expect(classifyPresenceRecord(rec({ pidStartedAt: T0 }), at(T0 + 2_000))).toBe('live');
  });
  it('unknown probe → kept even with an ancient heartbeat', () => {
    const r = rec({ pidStartedAt: T0, heartbeatAgeMs: LEGACY_STALE_HEARTBEAT_MS * 10 });
    expect(classifyPresenceRecord(r, undefined)).toBe('live');
  });
  it('legacy record with heartbeat ≥ 6h → stale-legacy', () => {
    expect(classifyPresenceRecord(rec({ heartbeatAgeMs: LEGACY_STALE_HEARTBEAT_MS }), undefined)).toBe('stale-legacy');
  });
  it('legacy record with fresh or absent heartbeat → live', () => {
    expect(classifyPresenceRecord(rec({ heartbeatAgeMs: LEGACY_STALE_HEARTBEAT_MS - 1 }), undefined)).toBe('live');
    expect(classifyPresenceRecord(rec({ heartbeatAgeMs: null }), undefined)).toBe('live');
  });
  it('linux ticks on both sides are compared exactly and override a clock-stepped epoch', () => {
    const r = rec({ pidStartedAt: T0, pidStartTicks: 4242 });
    // Wall clock stepped by an hour: btime-derived epoch is way off, ticks agree.
    expect(classifyPresenceRecord(r, { startedAtMs: T0 + 3_600_000, startTicks: 4242 })).toBe('live');
    expect(classifyPresenceRecord(r, { startedAtMs: T0, startTicks: 4243 })).toBe('reused');
  });
  it('falls back to epoch when only one side has ticks', () => {
    const r = rec({ pidStartedAt: T0, pidStartTicks: 4242 });
    expect(classifyPresenceRecord(r, at(T0 + 1_000))).toBe('live');
    expect(classifyPresenceRecord(rec({ pidStartedAt: T0 }), { startedAtMs: T0 + 3_600_000, startTicks: 1 })).toBe('reused');
  });
  it('ticks-only record with ticks-only probe works; ticks-only record with unknown probe is kept', () => {
    expect(classifyPresenceRecord(rec({ pidStartTicks: 7 }), { startTicks: 8 })).toBe('reused');
    expect(classifyPresenceRecord(rec({ pidStartTicks: 7, heartbeatAgeMs: LEGACY_STALE_HEARTBEAT_MS * 2 }), undefined)).toBe('live');
  });
  it('unknown pid liveness (unusable pid) is not dead', () => {
    expect(classifyPresenceRecord(rec({ liveness: 'unknown' }), undefined)).toBe('live');
  });
});

describe('filterVerifiedLive', () => {
  it('probes only records with pidStartedAt, in one batch, and filters by verdict', async () => {
    const probe = vi.fn(async () => new Map<number, ProcessStartInfo | undefined>([[1, at(T0)], [2, at(T0 + 3_600_000)], [3, undefined]]));
    const records = [
      rec({ sessionId: 'same', pid: 1, pidStartedAt: T0 }),
      rec({ sessionId: 'reused', pid: 2, pidStartedAt: T0 }),
      rec({ sessionId: 'unknown', pid: 3, pidStartedAt: T0 }),
      rec({ sessionId: 'legacy-fresh', pid: 4 }),
      rec({ sessionId: 'legacy-stale', pid: 5, heartbeatAgeMs: LEGACY_STALE_HEARTBEAT_MS + 1 }),
      rec({ sessionId: 'dead', pid: 6, pidStartedAt: T0, liveness: 'dead' }),
    ];
    const live = await filterVerifiedLive(records, probe);
    expect(live.map((r) => r.sessionId)).toEqual(['same', 'unknown', 'legacy-fresh']);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('a throwing probe keeps every non-dead record with pidStartedAt', async () => {
    const probe = vi.fn(async () => { throw new Error('boom'); });
    const live = await filterVerifiedLive([rec({ pidStartedAt: T0 })], probe);
    expect(live).toHaveLength(1);
  });

  it('skips the probe entirely when nothing carries pidStartedAt', async () => {
    const probe = vi.fn();
    await filterVerifiedLive([rec({})], probe);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('StartTimeProbeCache', () => {
  it('serves hits within the TTL, re-probes after it, and never caches unknown', async () => {
    let now = T0;
    const cache = new StartTimeProbeCache(START_TIME_PROBE_CACHE_TTL_MS, () => now);
    const probe = vi.fn(async () => new Map<number, ProcessStartInfo | undefined>([[1, at(T0)], [2, undefined]]));
    const records = [rec({ sessionId: 'a', pid: 1, pidStartedAt: T0 }), rec({ sessionId: 'b', pid: 2, pidStartedAt: T0 })];
    await filterVerifiedLive(records, probe, cache);
    expect(probe).toHaveBeenLastCalledWith([1, 2]);
    now += START_TIME_PROBE_CACHE_TTL_MS - 1;
    await filterVerifiedLive(records, probe, cache);
    // pid 1 cached; pid 2 was unknown so it is probed again.
    expect(probe).toHaveBeenLastCalledWith([2]);
    now += 1;
    await filterVerifiedLive(records, probe, cache);
    expect(probe).toHaveBeenLastCalledWith([1, 2]);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('keys on the recorded identity, so a new record for the same pid re-probes', async () => {
    const cache = new StartTimeProbeCache();
    const probe = vi.fn(async () => new Map<number, ProcessStartInfo | undefined>([[1, at(T0)]]));
    await filterVerifiedLive([rec({ pid: 1, pidStartedAt: T0 })], probe, cache);
    await filterVerifiedLive([rec({ pid: 1, pidStartedAt: T0 + 9_999_999 })], probe, cache);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('the shared default cache can be reset for tests', () => {
    expect(() => _resetStartTimeProbeCacheForTest()).not.toThrow();
  });
});

describe('readLivePresenceFiles integration', () => {
  let tmpDir: string;
  let orig: string | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-presence-liveness-'));
    orig = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (orig === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = orig;
  });

  it('hides a reused-pid record from readLivePresenceFiles but readPresenceFiles still sees it', async () => {
    const { writePresenceFile, readLivePresenceFiles, readPresenceFiles } = await import('./presence.js');
    const base = rec({});
    await writePresenceFile({ ...base, sessionId: 'reused', pid: process.pid, pidStartedAt: T0 });
    await writePresenceFile({ ...base, sessionId: 'ok', pid: process.pid, pidStartedAt: T0 + 3_600_000 });
    const startTimeProbe = async () => new Map<number, ProcessStartInfo | undefined>([[process.pid, at(T0 + 3_600_000)]]);
    // Both share a pid; only the one whose recorded start matches survives.
    const live = await readLivePresenceFiles({ startTimeProbe });
    expect(live.map((r) => r.sessionId)).toEqual(['ok']);
    expect((await readPresenceFiles()).map((r) => r.sessionId).sort()).toEqual(['ok', 'reused']);
  });
});
