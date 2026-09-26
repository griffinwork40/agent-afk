/**
 * Unit tests for the optional MCP health-check probe (issue #1751).
 *
 * Covered cases:
 *   1. `isMcpHealthCheckEnabled()` returns false when env var is absent
 *      (default off); an empty target list yields no results.
 *   2. A healthy server (listTools resolves quickly) → result is `healthy: true`.
 *   3. A server whose `listTools()` throws → result is `healthy: false` with
 *      the error message preserved.
 *   4. A server that times out → result is `healthy: false` with a timeout
 *      message at the deadline (fake timers), and the request signal aborts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runMcpHealthChecks,
  warnUnhealthyServers,
  isMcpHealthCheckEnabled,
  type HealthCheckTarget,
} from './health-check.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTarget(
  serverName: string,
  listTools: (signal?: AbortSignal) => Promise<unknown[]>,
): HealthCheckTarget {
  return { serverName, listTools };
}

// ── isMcpHealthCheckEnabled ───────────────────────────────────────────────────

describe('isMcpHealthCheckEnabled()', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env['AFK_MCP_HEALTHCHECK'];
  });

  afterEach(() => {
    if (original === undefined) delete process.env['AFK_MCP_HEALTHCHECK'];
    else process.env['AFK_MCP_HEALTHCHECK'] = original;
  });

  it('returns false when the env var is unset (default off)', () => {
    delete process.env['AFK_MCP_HEALTHCHECK'];
    expect(isMcpHealthCheckEnabled()).toBe(false);
  });

  it('returns false when the env var is "0"', () => {
    process.env['AFK_MCP_HEALTHCHECK'] = '0';
    expect(isMcpHealthCheckEnabled()).toBe(false);
  });

  it('returns true when the env var is "1"', () => {
    process.env['AFK_MCP_HEALTHCHECK'] = '1';
    expect(isMcpHealthCheckEnabled()).toBe(true);
  });

  it('returns true for other truthy values (true / yes / on)', () => {
    for (const val of ['true', 'yes', 'on', 'TRUE', 'YES']) {
      process.env['AFK_MCP_HEALTHCHECK'] = val;
      expect(isMcpHealthCheckEnabled()).toBe(true);
    }
  });
});

// ── runMcpHealthChecks — empty target list ───────────────────────────────────

describe('runMcpHealthChecks() — empty target list', () => {
  it('returns no results when given no targets', async () => {
    const results = await runMcpHealthChecks([]);
    expect(results).toHaveLength(0);
  });
});

// ── runMcpHealthChecks — healthy server ──────────────────────────────────────

describe('runMcpHealthChecks() — healthy server', () => {
  it('marks a server healthy when listTools resolves', async () => {
    const target = makeTarget('my-server', async () => [{ name: 'echo' }]);
    const [result] = await runMcpHealthChecks([target]);
    expect(result).toBeDefined();
    expect(result!.serverName).toBe('my-server');
    expect(result!.healthy).toBe(true);
    expect(result!.error).toBeUndefined();
    expect(result!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs probes in parallel and returns one result per target', async () => {
    const calls: string[] = [];
    const targets: HealthCheckTarget[] = [
      makeTarget('alpha', async () => { calls.push('alpha'); return []; }),
      makeTarget('beta', async () => { calls.push('beta'); return []; }),
      makeTarget('gamma', async () => { calls.push('gamma'); return []; }),
    ];
    const results = await runMcpHealthChecks(targets);
    expect(results).toHaveLength(3);
    expect(calls.sort()).toEqual(['alpha', 'beta', 'gamma']);
    for (const r of results) {
      expect(r.healthy).toBe(true);
    }
  });
});

// ── runMcpHealthChecks — server throws ───────────────────────────────────────

describe('runMcpHealthChecks() — server listTools throws', () => {
  it('marks server unhealthy and captures error message', async () => {
    const target = makeTarget('broken', async () => {
      throw new Error('connection reset');
    });
    const [result] = await runMcpHealthChecks([target]);
    expect(result!.serverName).toBe('broken');
    expect(result!.healthy).toBe(false);
    expect(result!.error).toContain('connection reset');
  });

  it('does not throw even when all servers fail', async () => {
    const targets = [
      makeTarget('a', async () => { throw new Error('fail-a'); }),
      makeTarget('b', async () => { throw new Error('fail-b'); }),
    ];
    await expect(runMcpHealthChecks(targets)).resolves.toHaveLength(2);
    const results = await runMcpHealthChecks(targets);
    for (const r of results) expect(r.healthy).toBe(false);
  });
});

// ── runMcpHealthChecks — server times out ────────────────────────────────────

describe('runMcpHealthChecks() — server times out', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks server unhealthy at the timeout deadline and aborts the request', async () => {
    vi.useFakeTimers();
    const PROBE_TIMEOUT = 100;
    let seenSignal: AbortSignal | undefined;
    const target = makeTarget('slow', (signal?: AbortSignal) => {
      seenSignal = signal;
      // never resolves
      return new Promise<unknown[]>(() => undefined);
    });

    let settled = false;
    const pending = runMcpHealthChecks([target], PROBE_TIMEOUT).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT - 1);
    expect(settled).toBe(false);
    expect(seenSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const [result] = await pending;

    expect(result!.serverName).toBe('slow');
    expect(result!.healthy).toBe(false);
    expect(result!.error).toMatch(/timed out/i);
    expect(seenSignal?.aborted).toBe(true);
  });
});

// ── warnUnhealthyServers ──────────────────────────────────────────────────────

describe('warnUnhealthyServers()', () => {
  it('calls console.warn for each unhealthy result', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnUnhealthyServers([
        { serverName: 'bad', healthy: false, error: 'oops', durationMs: 42 },
        { serverName: 'ok', healthy: true, durationMs: 10 },
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/bad/);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/oops/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not call console.warn when all servers are healthy', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnUnhealthyServers([
        { serverName: 'ok', healthy: true, durationMs: 5 },
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
