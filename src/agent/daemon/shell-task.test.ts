/**
 * Tests for shell-task executor.
 *
 * Covers: success path, nonzero exit, timeout, excerpt truncation (including
 * surrogate-pair safety), and telemetry write callback shape.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { runShellTask } from './shell-task.js';
import type { TelemetryRecord } from './scheduler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTelemetryCollector() {
  const records: TelemetryRecord[] = [];
  return {
    records,
    writeTelemetry: (r: TelemetryRecord) => records.push(r),
  };
}

/** Deterministic clock that starts at a fixed epoch and advances by `stepMs` each call. */
function makeSteppingClock(startMs = 1_700_000_000_000, stepMs = 50) {
  let t = startMs;
  return () => {
    const current = t;
    t += stepMs;
    return current;
  };
}

// ---------------------------------------------------------------------------
// 1. Success path
// ---------------------------------------------------------------------------

describe('runShellTask – success path', () => {
  it('returns status:success with stdout in responseExcerpt', async () => {
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'task-success', command: 'echo hello-world' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('success');
    expect(result.taskId).toBe('task-success');
    expect(result.trigger).toBe('cron');
    expect(result.responseExcerpt).toContain('hello-world');
    expect(result.errorMessage).toBeUndefined();
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sets triggeredAt as a valid ISO timestamp', async () => {
    const col = makeTelemetryCollector();
    const before = Date.now();
    const result = await runShellTask(
      { taskId: 'task-ts', command: 'echo ts-test' },
      'sessionstart',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );
    const after = Date.now();

    const parsed = new Date(result.triggeredAt).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it('forwards cronExpression when provided', async () => {
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'task-cron', command: 'echo cron', cronExpression: '0 * * * *' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.cronExpression).toBe('0 * * * *');
  });

  it('omits cronExpression when not provided', async () => {
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'task-nocron', command: 'echo no-cron' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect('cronExpression' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Nonzero exit
// ---------------------------------------------------------------------------

describe('runShellTask – nonzero exit', () => {
  it('returns status:error with errorMessage "exit N" on nonzero exit code', async () => {
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'task-fail', command: 'exit 42' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toBe('exit 42');
  });

  it('returns status:error with errorMessage "exit 1" for a failing command', async () => {
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'task-fail1', command: 'false' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toBe('exit 1');
  });

  it('captures stdout/stderr output in responseExcerpt on error', async () => {
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'task-err-output', command: 'echo fail-output; exit 2' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toBe('exit 2');
    expect(result.responseExcerpt).toContain('fail-output');
  });
});

// ---------------------------------------------------------------------------
// 3. Timeout
// ---------------------------------------------------------------------------

describe('runShellTask – timeout', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('maps a killed/timed-out process to status:error with a message that surfaces the timeout source', async () => {
    // Set a very short timeout (100ms) via the env var so `sleep 5` is killed.
    vi.stubEnv('AFK_DAEMON_SHELL_TIMEOUT_MS', '100');

    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'task-timeout', command: 'sleep 5' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('error');
    // The errorMessage should surface the daemon shell timeout source — either
    // "killed by daemon shell executor after N ms (AFK_DAEMON_SHELL_TIMEOUT_MS)"
    // or a system-level ETIMEDOUT message, depending on node version.
    expect(result.errorMessage).toBeTruthy();
    const msg = result.errorMessage!.toLowerCase();
    expect(msg.includes('timeout') || msg.includes('killed') || msg.includes('etimedout')).toBe(true);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 4. Excerpt truncation
// ---------------------------------------------------------------------------

describe('runShellTask – excerpt truncation', () => {
  it('tail-slices output exceeding EXCERPT_CAP (4096) on success path', async () => {
    // Build output of 5000 'x' chars — well above the 4096 cap.
    const longOutput = 'x'.repeat(5000);
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'task-long', command: `printf '%5000s' | tr ' ' x` },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('success');
    const excerpt = result.responseExcerpt ?? '';
    // The excerpt must be at most EXCERPT_CAP characters.
    expect(excerpt.length).toBeLessThanOrEqual(4096);
    // The tail (last 4096 chars) of the original long output should match excerpt.
    expect(longOutput.endsWith(excerpt)).toBe(true);
  });

  it('tail-slices output exceeding EXCERPT_CAP (4096) on error path', async () => {
    const longOutput = 'y'.repeat(5000);
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'task-long-err', command: `printf '%5000s' | tr ' ' y; exit 1` },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('error');
    const excerpt = result.responseExcerpt ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(4096);
    expect(longOutput.endsWith(excerpt)).toBe(true);
  });

  it('does not truncate output within the cap', async () => {
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'test-short', command: 'echo hello' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );
    expect(result.status).toBe('success');
    expect(result.responseExcerpt).toContain('hello');
  });

  it('produces a well-formed string when emoji lands at the exact cut point (success path)', async () => {
    // Build a string slightly above EXCERPT_CAP (4096) where the last char
    // before the cap boundary is the HIGH surrogate of a 4-byte emoji (🔥 =
    // U+1F525 = \uD83D\uDD25).  The string is: (4095 'a's) + '🔥' = 4097
    // code units.  A naive .slice(1) from position 1 would land on the LOW
    // surrogate \uDD25, producing a malformed lead code unit in the excerpt.
    const emoji = '🔥'; // 2 code units: \uD83D \uDD25
    const filler = 'a'.repeat(4095);
    const payload = filler + emoji; // length === 4097

    // Sanity: payload is 1 code unit over the cap so truncation fires.
    expect(payload.length).toBe(4097);

    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'test-emoji', command: `printf '%s' '${payload}'` },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    const excerpt = result.responseExcerpt ?? '';
    expect(excerpt).toBeDefined();
    // Must be well-formed — no lone surrogates
    expect(() => encodeURIComponent(excerpt)).not.toThrow();
    // The emoji should be present intact (not half-eaten)
    expect(excerpt).toContain(emoji);
  });

  it('produces a well-formed string when emoji lands at the cut point (error path)', async () => {
    const emoji = '💥'; // 2 code units: \uD83D \uDCA5
    const filler = 'a'.repeat(4095);
    const payload = filler + emoji; // 4097 code units

    const col = makeTelemetryCollector();
    // exit 1 forces the error path
    const result = await runShellTask(
      { taskId: 'test-emoji-err', command: `printf '%s' '${payload}'; exit 1` },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('error');
    const excerpt = result.responseExcerpt ?? '';
    expect(excerpt).toBeDefined();
    expect(() => encodeURIComponent(excerpt)).not.toThrow();
    expect(excerpt).toContain(emoji);
  });
});

// ---------------------------------------------------------------------------
// 5. Telemetry write callback shape
// ---------------------------------------------------------------------------

describe('runShellTask – telemetry write', () => {
  it('invokes writeTelemetry exactly once on success with correct record shape', async () => {
    const col = makeTelemetryCollector();
    const spy = vi.fn(col.writeTelemetry);
    const now = makeSteppingClock();

    await runShellTask(
      { taskId: 'task-tel-success', command: 'echo telemetry-test', cronExpression: '* * * * *' },
      'cron',
      { now, writeTelemetry: spy },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [record] = spy.mock.calls[0] as [TelemetryRecord];
    expect(record.taskId).toBe('task-tel-success');
    expect(record.command).toContain('echo telemetry-test');
    expect(record.trigger).toBe('cron');
    expect(record.cronExpression).toBe('* * * * *');
    expect(record.status).toBe('success');
    expect(typeof record.triggeredAt).toBe('string');
    expect(typeof record.durationMs).toBe('number');
    expect(record.responseExcerpt).toContain('telemetry-test');
    expect(record.errorMessage).toBeUndefined();
  });

  it('invokes writeTelemetry exactly once on error with correct record shape', async () => {
    const col = makeTelemetryCollector();
    const spy = vi.fn(col.writeTelemetry);
    const now = makeSteppingClock();

    await runShellTask(
      { taskId: 'task-tel-error', command: 'echo err-output; exit 3' },
      'sessionstart',
      { now, writeTelemetry: spy },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [record] = spy.mock.calls[0] as [TelemetryRecord];
    expect(record.taskId).toBe('task-tel-error');
    expect(record.trigger).toBe('sessionstart');
    expect(record.status).toBe('error');
    expect(record.errorMessage).toBe('exit 3');
    expect(record.responseExcerpt).toContain('err-output');
    expect(typeof record.durationMs).toBe('number');
  });

  it('returned record and the writeTelemetry argument are the same object', async () => {
    const col = makeTelemetryCollector();
    const spy = vi.fn(col.writeTelemetry);

    const result = await runShellTask(
      { taskId: 'task-ref', command: 'echo ref-check' },
      'cron',
      { now: Date.now.bind(Date), writeTelemetry: spy },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [passedRecord] = spy.mock.calls[0] as [TelemetryRecord];
    expect(result).toBe(passedRecord);
  });

  it('durationMs reflects the wall-clock time via the injected now()', async () => {
    const col = makeTelemetryCollector();
    // Clock: first call (triggeredAt) = 1000, second call (startTimeMs) = 1050,
    // third call (end) = 1300 → durationMs = 1300 - 1050 = 250.
    let callCount = 0;
    const times = [1000, 1050, 1300];
    const now = () => times[Math.min(callCount++, times.length - 1)] ?? 0;

    await runShellTask(
      { taskId: 'task-duration', command: 'echo duration-test' },
      'cron',
      { now, writeTelemetry: col.writeTelemetry },
    );

    // durationMs = third call - second call = 1300 - 1050 = 250
    expect(col.records[0]?.durationMs).toBe(250);
  });
});
