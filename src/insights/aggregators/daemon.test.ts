/**
 * Unit tests for the daemon telemetry aggregator.
 *
 * Strategy: synthetic temp-dir fixtures with controlled JSONL content.
 * No real forge-telemetry.jsonl reads.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateDaemonTelemetry } from './daemon.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `afk-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpRoot, 'agent-framework'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeTelemetry(lines: string[]): void {
  writeFileSync(
    join(tmpRoot, 'agent-framework', 'forge-telemetry.jsonl'),
    lines.join('\n') + '\n',
    'utf-8',
  );
}

const RECENT_TS = new Date().toISOString();

function makeRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    taskId: 'task-abc',
    command: 'pnpm test',
    trigger: 'cron',
    triggeredAt: RECENT_TS,
    durationMs: 5000,
    status: 'success',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregateDaemonTelemetry', () => {
  it('missing forge-telemetry.jsonl → zero aggregates, no throw', () => {
    const result = aggregateDaemonTelemetry({ days: 30, afkHome: '/nonexistent/xyz' });
    expect(result.totalRuns).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.skipCount).toBe(0);
    expect(result.avgDurationMs).toBe(0);
    expect(result.recentErrors).toHaveLength(0);
  });

  it('zero aggregates when file does not exist at afkHome', () => {
    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    // No file written — should be empty
    expect(result.totalRuns).toBe(0);
  });

  it('3 success, 1 error, 1 skip → correct totals', () => {
    writeTelemetry([
      makeRecord({ status: 'success' }),
      makeRecord({ status: 'success' }),
      makeRecord({ status: 'success' }),
      makeRecord({ status: 'error', errorMessage: 'something failed' }),
      makeRecord({ status: 'skipped', skipReason: 'cooldown' }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.totalRuns).toBe(5);
    expect(result.successCount).toBe(3);
    expect(result.errorCount).toBe(1);
    expect(result.skipCount).toBe(1);
  });

  it('responseExcerpt in error record → never appears in DaemonAggregates output', () => {
    const SECRET_CONTENT = 'sensitive-response-content-xyz';
    writeTelemetry([
      makeRecord({
        status: 'error',
        errorMessage: 'task failed',
        responseExcerpt: SECRET_CONTENT,
      }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_CONTENT);
    // recentErrors should exist but contain only safe fields
    expect(result.recentErrors).toHaveLength(1);
    expect(result.recentErrors[0]).not.toHaveProperty('responseExcerpt');
  });

  it('records outside days window excluded by triggeredAt', () => {
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    writeTelemetry([
      makeRecord({ triggeredAt: oldTs }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.totalRuns).toBe(0);
  });

  it('avg duration computed correctly across n records', () => {
    writeTelemetry([
      makeRecord({ durationMs: 1000 }),
      makeRecord({ durationMs: 3000 }),
      makeRecord({ durationMs: 2000 }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.avgDurationMs).toBeCloseTo(2000);
  });

  it('trigger breakdown counts by trigger field', () => {
    writeTelemetry([
      makeRecord({ trigger: 'cron' }),
      makeRecord({ trigger: 'cron' }),
      makeRecord({ trigger: 'sessionstart' }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.triggerBreakdown['cron']).toBe(2);
    expect(result.triggerBreakdown['sessionstart']).toBe(1);
  });

  it('skip reason distribution accumulated', () => {
    writeTelemetry([
      makeRecord({ status: 'skipped', skipReason: 'cooldown' }),
      makeRecord({ status: 'skipped', skipReason: 'cooldown' }),
      makeRecord({ status: 'skipped', skipReason: 'brief_pending' }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.skipReasons['cooldown']).toBe(2);
    expect(result.skipReasons['brief_pending']).toBe(1);
  });

  it('recent errors capped at 5, sorted by ts desc', () => {
    const errors = Array.from({ length: 8 }, (_, i) => {
      const ts = new Date(Date.now() - i * 1000).toISOString(); // progressively older
      return makeRecord({ status: 'error', errorMessage: `error-${i}`, triggeredAt: ts });
    });
    writeTelemetry(errors);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.recentErrors).toHaveLength(5);
    // Most recent error should be first (error-0 was triggeredAt = now)
    expect(result.recentErrors[0]!.message).toBe('error-0');
  });

  it('malformed line → skipped, no throw', () => {
    writeTelemetry([
      '{ not valid json }',
      makeRecord({ status: 'success' }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.totalRuns).toBe(1);
    expect(result.successCount).toBe(1);
  });

  it('valid-JSON non-object lines (null, number, string, array) → skipped, no throw', () => {
    // Regression: these parse cleanly (unlike syntactically-broken JSON) and
    // escape the parse catch. Without the null/object guard, a bare `null`
    // line crashes the aggregator on the first property access.
    writeTelemetry([
      'null',
      '42',
      '"just a string"',
      '[1, 2, 3]',
      makeRecord({ status: 'success' }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.totalRuns).toBe(1);
    expect(result.successCount).toBe(1);
  });

  it('byTaskId breakdown accumulated per task', () => {
    writeTelemetry([
      makeRecord({ taskId: 'task-A', status: 'success' }),
      makeRecord({ taskId: 'task-A', status: 'error', errorMessage: 'fail' }),
      makeRecord({ taskId: 'task-B', status: 'success' }),
      makeRecord({ taskId: 'task-B', status: 'skipped', skipReason: 'cooldown' }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.byTaskId['task-A']?.success).toBe(1);
    expect(result.byTaskId['task-A']?.error).toBe(1);
    expect(result.byTaskId['task-B']?.success).toBe(1);
    expect(result.byTaskId['task-B']?.skip).toBe(1);
  });

  it('records without taskId or status are skipped', () => {
    writeTelemetry([
      JSON.stringify({ triggeredAt: RECENT_TS, durationMs: 100 }), // no taskId/status
      makeRecord({ status: 'success' }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.totalRuns).toBe(1); // only the valid record
  });

  it('avgDurationMs is 0 when no duration fields present', () => {
    writeTelemetry([
      JSON.stringify({
        taskId: 'task-x',
        status: 'success',
        trigger: 'cron',
        triggeredAt: RECENT_TS,
        // no durationMs
      }),
    ]);

    const result = aggregateDaemonTelemetry({ days: 30, afkHome: tmpRoot });
    expect(result.avgDurationMs).toBe(0);
  });
});
