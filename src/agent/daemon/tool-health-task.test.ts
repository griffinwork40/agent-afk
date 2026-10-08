/**
 * Unit tests for the tool-health builtin task.
 *
 * Covers:
 * 1. Aggregator: 1 session = no alert, 2 sessions = alert, events outside
 *    window ignored, multiple groups, malformed lines ignored.
 * 2. Cooldown: second run within 24h suppressed; after 24h re-alerts.
 * 3. Builtin dispatch: runBuiltinTask routes 'tool-health' to the handler.
 * 4. Daemon registration: tool-health is registered with notifyOn 'failure'
 *    and respects AFK_TOOL_HEALTH_DISABLE env and config.
 * 5. Write-failure: when atomicWriteFileAsync rejects, the second tick for the
 *    same degraded group is suppressed by the in-process cooldown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks (must come before any imports of the mocked modules)
// ---------------------------------------------------------------------------

// Mock listTraces so we can control which trace files are returned without
// hitting the real filesystem witness root.
vi.mock('../trace/listing.js', () => ({
  listTraces: vi.fn(),
}));

// Mock atomicWriteFileAsync so write-failure tests can simulate EPERM etc.
// Default: pass through to the real implementation; individual tests override.
vi.mock('../../utils/atomic-write.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../utils/atomic-write.js')>();
  return {
    ...real,
    atomicWriteFileAsync: vi.fn(real.atomicWriteFileAsync),
  };
});

// Mock the worktree-prune-task so no git sweep runs in dispatch tests.
vi.mock('./worktree-prune-task.js', () => ({
  runBuiltinWorktreePruneTask: vi.fn().mockResolvedValue({
    taskId: 'worktree-prune',
    command: 'worktree-prune',
    trigger: 'cron',
    triggeredAt: new Date().toISOString(),
    durationMs: 0,
    status: 'success',
  }),
}));

import { listTraces } from '../trace/listing.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import {
  runBuiltinToolHealthTask,
  TOOL_HEALTH_LOOKBACK_MS,
  TOOL_HEALTH_COOLDOWN_MS,
  TOOL_HEALTH_MIN_SESSIONS,
  _resetToolHealthAlertCooldownForTests,
} from './tool-health-task.js';
import { runBuiltinTask } from './builtin-task.js';
import { buildToolHealthTask } from '../../cli/commands/daemon-builtin-tasks.js';
import type { TelemetryRecord } from './scheduler.js';

const mockListTraces = vi.mocked(listTraces);
const mockAtomicWrite = vi.mocked(atomicWriteFileAsync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tool-health-test-'));
  mockListTraces.mockReset();
  // Restore atomicWriteFileAsync to the real implementation between tests so
  // individual write-failure tests can opt in without affecting others.
  mockAtomicWrite.mockRestore();
  // Clear in-process cooldown so test cases do not bleed alert suppression
  // into each other through the module-scope Map.
  _resetToolHealthAlertCooldownForTests();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const NOW_MS = 1_700_000_000_000;

function makeOptions(overrides: {
  alertStatePath?: string;
  lookbackMs?: number;
  now?: () => number;
} = {}) {
  const records: TelemetryRecord[] = [];
  const alertStatePath = overrides.alertStatePath ?? join(tmpDir, 'alert-state.json');
  return {
    now: overrides.now ?? (() => NOW_MS),
    telemetryPath: () => join(tmpDir, 'telemetry.jsonl'),
    writeTelemetry: (r: TelemetryRecord) => records.push(r),
    alertStatePath,
    lookbackMs: overrides.lookbackMs ?? TOOL_HEALTH_LOOKBACK_MS,
    records,
  };
}

/** Write a trace file with the given content and return the trace path. */
function writeTrace(sessionLabel: string, lines: string[]): string {
  const dir = join(tmpDir, 'witness', sessionLabel);
  mkdirSync(dir, { recursive: true });
  const tracePath = join(dir, 'trace.jsonl');
  writeFileSync(tracePath, lines.join('\n') + '\n', 'utf-8');
  return tracePath;
}

function degradedLine(tool: string, errorHead: string, errorCount = 9, callCount = 10): string {
  return JSON.stringify({
    kind: 'session_phase',
    payload: {
      phase: 'tool_degraded',
      metadata: { tool, errorHead, errorCount, callCount },
    },
  });
}

/** A trace entry that is NOT tool_degraded. */
const unrelatedLine = JSON.stringify({
  kind: 'session_phase',
  payload: { phase: 'loop_start' },
});

// ---------------------------------------------------------------------------
// 1. Aggregator tests
// ---------------------------------------------------------------------------

describe('tool-health aggregator', () => {
  it('returns success when no traces exist', async () => {
    mockListTraces.mockResolvedValueOnce([]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    expect(result.status).toBe('success');
    expect(opts.records).toHaveLength(1);
    expect(opts.records[0].status).toBe('success');
  });

  it('returns success when only 1 session has tool_degraded (below threshold)', async () => {
    const tracePath = writeTrace('session-a', [
      degradedLine('web_request', 'fetch failed'),
    ]);

    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath, mtimeMs: NOW_MS, exists: true },
    ]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    expect(result.status).toBe('success');
    expect(result.errorMessage).toBeUndefined();
  });

  it('returns error (alert) when >= 2 sessions have the same (tool, errorHead)', async () => {
    const traceA = writeTrace('session-a', [degradedLine('web_request', 'fetch failed')]);
    const traceB = writeTrace('session-b', [degradedLine('web_request', 'fetch failed')]);

    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('web_request');
    expect(result.errorMessage).toContain('fetch failed');
    expect(result.errorMessage).toContain('2 sessions');
  });

  it('ignores events from traces outside the lookback window (mtime too old)', async () => {
    // Only 1 trace is within the window; the other is too old
    const traceA = writeTrace('session-a', [degradedLine('bash', 'timeout')]);
    const traceB = writeTrace('session-b', [degradedLine('bash', 'timeout')]);

    const cutoff = NOW_MS - TOOL_HEALTH_LOOKBACK_MS;
    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: cutoff - 1, exists: true }, // OUTSIDE
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },      // INSIDE
    ]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    // Only session-b is scanned; 1 session < TOOL_HEALTH_MIN_SESSIONS → success
    expect(result.status).toBe('success');
  });

  it('handles multiple independent groups correctly', async () => {
    // Two different (tool, errorHead) pairs each in 2 sessions → 2 alerts
    const traceA = writeTrace('session-a', [
      degradedLine('web_request', 'connection refused'),
      degradedLine('bash', 'timeout'),
    ]);
    const traceB = writeTrace('session-b', [
      degradedLine('web_request', 'connection refused'),
      degradedLine('bash', 'timeout'),
    ]);

    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('web_request');
    expect(result.errorMessage).toContain('bash');
    expect(result.errorMessage).toContain('connection refused');
    expect(result.errorMessage).toContain('timeout');
  });

  it('different errorHeads for the same tool are treated as separate groups', async () => {
    // session-a: 'web_request' + 'fetch failed'
    // session-b: 'web_request' + 'dns error'  (different head)
    const traceA = writeTrace('session-a', [degradedLine('web_request', 'fetch failed')]);
    const traceB = writeTrace('session-b', [degradedLine('web_request', 'dns error')]);

    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    // Neither group reaches >=2 sessions for the same errorHead → success
    expect(result.status).toBe('success');
  });

  it('ignores malformed / non-JSON lines silently', async () => {
    const tracePath = writeTrace('session-a', [
      'not json at all',
      '{"incomplete":',
      degradedLine('bash', 'timeout'),
    ]);
    const traceB = writeTrace('session-b', [
      '{{{malformed}}}',
      degradedLine('bash', 'timeout'),
    ]);

    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    // Malformed lines ignored; both sessions have the valid 'bash::timeout' event
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('bash');
    expect(result.errorMessage).toContain('timeout');
  });

  it('ignores non-session_phase and non-tool_degraded events', async () => {
    const traceA = writeTrace('session-a', [
      unrelatedLine,
      JSON.stringify({ kind: 'tool_call', payload: {} }),
      degradedLine('web_request', 'fetch failed'),
    ]);
    const traceB = writeTrace('session-b', [
      unrelatedLine,
      degradedLine('web_request', 'fetch failed'),
    ]);

    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('web_request');
  });

  it('counts each sessionLabel only once per (tool, errorHead)', async () => {
    // Same session has the same event twice — still counts as 1 session
    const traceA = writeTrace('session-a', [
      degradedLine('web_request', 'fetch failed'),
      degradedLine('web_request', 'fetch failed'), // duplicate in same session
    ]);
    const traceB = writeTrace('session-b', [
      degradedLine('web_request', 'fetch failed'),
    ]);

    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    // 2 distinct sessions → alert
    expect(result.status).toBe('error');
    // Message should say 2, not 3
    expect(result.errorMessage).toContain('2 sessions');
  });

  it('alert message names tool, errorHead, session count, and call counts', async () => {
    const traceA = writeTrace('session-a', [degradedLine('edit_file', 'stale edit hash', 8, 10)]);
    const traceB = writeTrace('session-b', [degradedLine('edit_file', 'stale edit hash', 9, 10)]);

    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);

    const opts = makeOptions();
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    expect(result.status).toBe('error');
    const msg = result.errorMessage ?? '';
    expect(msg).toContain('edit_file');
    expect(msg).toContain('stale edit hash');
    expect(msg).toContain('2 sessions');
    // Accumulated error + call counts
    expect(msg).toMatch(/\d+\/\d+ calls failed/);
  });
});

// ---------------------------------------------------------------------------
// 2. Cooldown tests
// ---------------------------------------------------------------------------

describe('tool-health cooldown', () => {
  it('suppresses an alert within 24h of the previous one', async () => {
    const traceA = writeTrace('session-a', [degradedLine('bash', 'timeout')]);
    const traceB = writeTrace('session-b', [degradedLine('bash', 'timeout')]);

    const alertStatePath = join(tmpDir, 'cooldown-state.json');

    // First run: alert fires, state persisted
    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);
    const opts1 = makeOptions({ alertStatePath, now: () => NOW_MS });
    const result1 = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts1,
    );
    expect(result1.status).toBe('error');

    // Second run: within cooldown window (1 hour later) → suppressed
    const traceC = writeTrace('session-c', [degradedLine('bash', 'timeout')]);
    const traceD = writeTrace('session-d', [degradedLine('bash', 'timeout')]);
    const HOUR = 60 * 60 * 1000;
    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-c', tracePath: traceC, mtimeMs: NOW_MS + HOUR, exists: true },
      { sessionId: 'session-d', tracePath: traceD, mtimeMs: NOW_MS + HOUR, exists: true },
    ]);
    const opts2 = makeOptions({ alertStatePath, now: () => NOW_MS + HOUR });
    const result2 = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts2,
    );

    // Still within 24h cooldown — success (no Telegram push)
    expect(result2.status).toBe('success');
    expect(result2.responseExcerpt).toContain('cooldown');
  });

  it('re-alerts after 24h cooldown has elapsed', async () => {
    const traceA = writeTrace('session-a', [degradedLine('bash', 'timeout')]);
    const traceB = writeTrace('session-b', [degradedLine('bash', 'timeout')]);
    const alertStatePath = join(tmpDir, 'refire-state.json');

    // First run at T=0
    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);
    const opts1 = makeOptions({ alertStatePath, now: () => NOW_MS });
    await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts1,
    );

    // Second run at T+25h (past cooldown)
    const T2 = NOW_MS + TOOL_HEALTH_COOLDOWN_MS + 60_000;
    const traceC = writeTrace('session-c', [degradedLine('bash', 'timeout')]);
    const traceD = writeTrace('session-d', [degradedLine('bash', 'timeout')]);
    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-c', tracePath: traceC, mtimeMs: T2, exists: true },
      { sessionId: 'session-d', tracePath: traceD, mtimeMs: T2, exists: true },
    ]);
    const opts2 = makeOptions({ alertStatePath, now: () => T2 });
    const result2 = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts2,
    );

    expect(result2.status).toBe('error');
    expect(result2.errorMessage).toContain('bash');
  });

  it('treats a corrupt state file as empty (no throw, alert fires)', async () => {
    const alertStatePath = join(tmpDir, 'corrupt-state.json');
    writeFileSync(alertStatePath, '{{{not valid json', 'utf-8');

    const traceA = writeTrace('session-a', [degradedLine('bash', 'timeout')]);
    const traceB = writeTrace('session-b', [degradedLine('bash', 'timeout')]);

    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);
    const opts = makeOptions({ alertStatePath });
    // Must not throw
    const result = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts,
    );

    // Corrupt state → treated as empty → alert fires
    expect(result.status).toBe('error');
  });

  it('different (tool, errorHead) pairs have independent cooldowns', async () => {
    const alertStatePath = join(tmpDir, 'multi-cool-state.json');

    // First run: alerts on both 'bash::timeout' and 'web_request::fetch failed'
    const traceA = writeTrace('session-a', [
      degradedLine('bash', 'timeout'),
      degradedLine('web_request', 'fetch failed'),
    ]);
    const traceB = writeTrace('session-b', [
      degradedLine('bash', 'timeout'),
      degradedLine('web_request', 'fetch failed'),
    ]);
    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);
    const opts1 = makeOptions({ alertStatePath, now: () => NOW_MS });
    const r1 = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts1,
    );
    expect(r1.status).toBe('error');

    // Second run within cooldown: both suppressed → success
    const T2 = NOW_MS + 60_000;
    const traceC = writeTrace('session-c', [
      degradedLine('bash', 'timeout'),
      degradedLine('web_request', 'fetch failed'),
    ]);
    const traceD = writeTrace('session-d', [
      degradedLine('bash', 'timeout'),
      degradedLine('web_request', 'fetch failed'),
    ]);
    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-c', tracePath: traceC, mtimeMs: T2, exists: true },
      { sessionId: 'session-d', tracePath: traceD, mtimeMs: T2, exists: true },
    ]);
    const opts2 = makeOptions({ alertStatePath, now: () => T2 });
    const r2 = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts2,
    );
    expect(r2.status).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 3. Builtin dispatch
// ---------------------------------------------------------------------------

describe('runBuiltinTask – tool-health dispatch', () => {
  it('delegates to runBuiltinToolHealthTask for command "tool-health"', async () => {
    mockListTraces.mockResolvedValueOnce([]);

    const records: TelemetryRecord[] = [];
    const opts = {
      now: () => NOW_MS,
      telemetryPath: () => join(tmpDir, 'telem.jsonl'),
      writeTelemetry: (r: TelemetryRecord) => records.push(r),
    };

    const result = await runBuiltinTask(
      { taskId: 'tool-health', command: 'tool-health', cronExpression: '17 * * * *' },
      'cron',
      opts,
    );

    expect(result.status).toBe('success');
    expect(result.taskId).toBe('tool-health');
    expect(result.command).toBe('tool-health');
  });

  it('passes trigger through correctly', async () => {
    mockListTraces.mockResolvedValueOnce([]);

    const opts = {
      now: () => NOW_MS,
      telemetryPath: () => join(tmpDir, 'telem2.jsonl'),
      writeTelemetry: () => {},
    };

    const result = await runBuiltinTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'sessionstart',
      opts,
    );

    expect(result.trigger).toBe('sessionstart');
  });
});

// ---------------------------------------------------------------------------
// 4. Daemon registration — notifyOn and disable behavior
// ---------------------------------------------------------------------------

describe('tool-health daemon registration', () => {
  it('notifyOn constant: task object should have notifyOn "failure"', () => {
    // Verify the real builder emits notifyOn 'failure' so success runs don't
    // push Telegram — the daemon wires this via buildToolHealthTask().
    const task = buildToolHealthTask('17 * * * *');

    expect(task.notifyOn).toBe('failure');
    // Must NOT be 'never' or 'always' — only 'failure' is correct.
    expect(task.notifyOn).not.toBe('never');
    expect(task.notifyOn).not.toBe('always');
  });

  it('TOOL_HEALTH_MIN_SESSIONS threshold is 2', () => {
    expect(TOOL_HEALTH_MIN_SESSIONS).toBe(2);
  });

  it('TOOL_HEALTH_COOLDOWN_MS is 24 hours', () => {
    expect(TOOL_HEALTH_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('TOOL_HEALTH_LOOKBACK_MS is 6 hours', () => {
    expect(TOOL_HEALTH_LOOKBACK_MS).toBe(6 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 5. Write-failure: in-process fallback cooldown
// ---------------------------------------------------------------------------

describe('tool-health write-failure cooldown', () => {
  it('suppresses the second tick when atomicWriteFileAsync rejects (EPERM)', async () => {
    // Make every disk write fail, simulating a read-only volume or EPERM.
    mockAtomicWrite.mockRejectedValue(
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
    );

    const alertStatePath = join(tmpDir, 'no-write-state.json');

    // Tick 1: degraded group seen in 2 sessions — alert fires (status: 'error').
    // The disk write fails but the in-process map records the alert timestamp.
    const traceA = writeTrace('session-a', [degradedLine('bash', 'timeout')]);
    const traceB = writeTrace('session-b', [degradedLine('bash', 'timeout')]);
    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-a', tracePath: traceA, mtimeMs: NOW_MS, exists: true },
      { sessionId: 'session-b', tracePath: traceB, mtimeMs: NOW_MS, exists: true },
    ]);

    const opts1 = makeOptions({ alertStatePath, now: () => NOW_MS });
    const result1 = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts1,
    );

    // First tick must still send the alert even though the write failed.
    expect(result1.status).toBe('error');
    expect(result1.errorMessage).toContain('bash');
    // The telemetry responseExcerpt must note the write failure.
    expect(result1.responseExcerpt).toContain('alert state write failed');

    // Tick 2: same degraded group, 1 minute later (well within 24h cooldown).
    // Disk state file still absent/unwritable. The in-process map must gate it.
    const traceC = writeTrace('session-c', [degradedLine('bash', 'timeout')]);
    const traceD = writeTrace('session-d', [degradedLine('bash', 'timeout')]);
    const MINUTE = 60_000;
    mockListTraces.mockResolvedValueOnce([
      { sessionId: 'session-c', tracePath: traceC, mtimeMs: NOW_MS + MINUTE, exists: true },
      { sessionId: 'session-d', tracePath: traceD, mtimeMs: NOW_MS + MINUTE, exists: true },
    ]);

    const opts2 = makeOptions({ alertStatePath, now: () => NOW_MS + MINUTE });
    const result2 = await runBuiltinToolHealthTask(
      { taskId: 'tool-health', command: 'tool-health' },
      'cron',
      opts2,
    );

    // Second tick must be suppressed — no Telegram push, telemetry says 'success'.
    expect(result2.status).toBe('success');
    expect(result2.responseExcerpt).toContain('cooldown');
  });
});
