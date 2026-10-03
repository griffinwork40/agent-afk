/**
 * Tests for process start-time probing. Platform and exec are injected, so
 * every branch runs on every host (no platform-gated tests).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseEtime,
  parsePsStartTimes,
  parseProcStatStartTicks,
  parseProcBootTime,
  probeProcessStartTimes,
  ownProcessStartedAt,
  LINUX_CLOCK_TICKS_PER_SEC,
} from './process-liveness.start-time.js';

describe('parseEtime', () => {
  it('parses mm:ss', () => expect(parseEtime('05:07')).toBe(307));
  it('parses hh:mm:ss', () => expect(parseEtime('02:05:07')).toBe(2 * 3600 + 307));
  it('parses dd-hh:mm:ss', () => expect(parseEtime('3-02:05:07')).toBe(3 * 86400 + 2 * 3600 + 307));
  it('tolerates surrounding whitespace', () => expect(parseEtime('  00:01 ')).toBe(1));
  it('rejects malformed values', () => {
    for (const bad of ['', 'abc', '5', '1:2:3:4', '00:61', '1-25:00:00', '-01:00']) {
      expect(parseEtime(bad)).toBeUndefined();
    }
  });
});

describe('parsePsStartTimes', () => {
  it('maps each row to now - elapsed and skips junk lines', () => {
    const now = 1_000_000_000;
    const out = parsePsStartTimes('  123    01:00\n 456 1-00:00:00\ngarbage\n\n', now);
    expect(out.get(123)).toBe(now - 60_000);
    expect(out.get(456)).toBe(now - 86_400_000);
    expect(out.size).toBe(2);
  });
});

describe('Linux /proc parsing', () => {
  // 52 fields; field 22 (starttime) is 4242. comm contains spaces AND a ')'.
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
  fields[19] = '4242';
  const stat = `999 (weird) name (x)) ${fields.join(' ')}`;

  it('reads field 22 after the LAST paren even when comm contains ")"', () => {
    expect(parseProcStatStartTicks(stat)).toBe(4242);
  });
  it('returns undefined for truncated stat', () => {
    expect(parseProcStatStartTicks('1 (x) S 1')).toBeUndefined();
    expect(parseProcStatStartTicks('no parens')).toBeUndefined();
  });
  it('reads btime from /proc/stat', () => {
    expect(parseProcBootTime('cpu 1 2 3\nbtime 1700000000\nprocesses 5\n')).toBe(1_700_000_000);
    expect(parseProcBootTime('cpu 1 2 3\n')).toBeUndefined();
  });

  it('probes via injected readFile on linux', async () => {
    const readFile = vi.fn(async (p: string) => {
      if (p === '/proc/stat') return 'btime 1700000000\n';
      if (p === '/proc/999/stat') return stat;
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    });
    const out = await probeProcessStartTimes([999, 1000], { platform: 'linux', readFile });
    expect(out.get(999)).toBe((1_700_000_000 + 4242 / LINUX_CLOCK_TICKS_PER_SEC) * 1000);
    expect(out.has(1000)).toBe(true);
    expect(out.get(1000)).toBeUndefined();
  });
});

describe('probeProcessStartTimes (ps)', () => {
  it('batches pids into one ps call and parses partial output from a non-zero exit', async () => {
    // ps exits 1 when any pid is missing but still prints the live rows; the
    // exec seam surfaces stdout regardless of exit code.
    const exec = vi.fn(async () => ({ stdout: '  10 00:30\n' }));
    const out = await probeProcessStartTimes([10, 11, 10], { platform: 'darwin', exec, now: () => 100_000 });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('ps', ['-o', 'pid=', '-o', 'etime=', '-p', '10,11']);
    expect(out.get(10)).toBe(70_000);
    expect(out.get(11)).toBeUndefined();
  });

  it('never throws when exec rejects — every pid is unknown', async () => {
    const exec = vi.fn(async () => { throw new Error('spawn failed'); });
    const out = await probeProcessStartTimes([1, 2], { platform: 'darwin', exec });
    expect([...out.values()]).toEqual([undefined, undefined]);
  });

  it('returns unknown on win32 without executing anything', async () => {
    const exec = vi.fn();
    const out = await probeProcessStartTimes([5], { platform: 'win32', exec });
    expect(out.get(5)).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it('skips invalid pids and returns empty for no pids', async () => {
    const exec = vi.fn();
    expect((await probeProcessStartTimes([0, -1, 1.5], { platform: 'darwin', exec })).size).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('agrees with ownProcessStartedAt for this process on the real host probe', async () => {
    // Real probe, no platform gate: on hosts where the probe is unsupported the
    // result is undefined and the assertion is vacuous by design.
    const out = await probeProcessStartTimes([process.pid]);
    const probed = out.get(process.pid);
    if (probed !== undefined) {
      expect(Math.abs(probed - ownProcessStartedAt())).toBeLessThan(5_000);
    }
  });
});
