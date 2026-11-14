/**
 * Tests for Phase 6 sessionstart gates — cooldown.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateSessionStartGates,
  readLastTickTime,
  DEFAULT_SESSIONSTART_COOLDOWN_MS,
} from './gates.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-afk-gates-'));
}

describe('readLastTickTime', () => {
  let dir: string;
  let telemetryPath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when file does not exist', async () => {
    expect(await readLastTickTime('any', telemetryPath)).toBeNull();
  });

  it('returns null when file has no matching taskId', async () => {
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({ taskId: 'other', triggeredAt: '2026-04-18T10:00:00Z' })}\n`,
    );
    expect(await readLastTickTime('missing', telemetryPath)).toBeNull();
  });

  it('returns the most recent triggeredAt for the task', async () => {
    const earlier = '2026-04-18T08:00:00Z';
    const later = '2026-04-18T10:00:00Z';
    writeFileSync(
      telemetryPath,
      [
        JSON.stringify({ taskId: 't', triggeredAt: earlier }),
        JSON.stringify({ taskId: 'other', triggeredAt: later }),
        JSON.stringify({ taskId: 't', triggeredAt: later }),
      ].join('\n') + '\n',
    );
    expect(await readLastTickTime('t', telemetryPath)).toBe(Date.parse(later));
  });

  it('ignores malformed lines', async () => {
    writeFileSync(
      telemetryPath,
      [
        'not-json',
        JSON.stringify({ taskId: 't', triggeredAt: '2026-04-18T09:00:00Z' }),
        '{incomplete',
      ].join('\n') + '\n',
    );
    expect(await readLastTickTime('t', telemetryPath)).toBe(Date.parse('2026-04-18T09:00:00Z'));
  });

  it('finds a real tick buried behind 15 consecutive skipped records (#4647)', async () => {
    // The old limit:10 would exhaust the window entirely on 10 skipped records
    // and return null, causing the cooldown gate to fail open.
    const realFiredAt = '2026-04-18T08:00:00Z';
    const skippedRecord = (n: number) =>
      JSON.stringify({
        taskId: 't',
        triggeredAt: `2026-04-18T09:${String(n).padStart(2, '0')}:00Z`,
        status: 'skipped',
      });
    const lines = [
      JSON.stringify({ taskId: 't', triggeredAt: realFiredAt }), // the real tick
      ...Array.from({ length: 15 }, (_, i) => skippedRecord(i)), // 15 consecutive skips
    ];
    writeFileSync(telemetryPath, lines.join('\n') + '\n');
    // With limit:50 the real tick is visible; with limit:10 it would be null.
    expect(await readLastTickTime('t', telemetryPath)).toBe(Date.parse(realFiredAt));
  });

  it('skips all records with status skipped and returns null when no real tick exists', async () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        taskId: 't',
        triggeredAt: `2026-04-18T09:${String(i).padStart(2, '0')}:00Z`,
        status: 'skipped',
      }),
    );
    writeFileSync(telemetryPath, lines.join('\n') + '\n');
    expect(await readLastTickTime('t', telemetryPath)).toBeNull();
  });
});

describe('evaluateSessionStartGates', () => {
  let dir: string;
  let telemetryPath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'telemetry.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires when no prior telemetry', async () => {
    const decision = await evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: DEFAULT_SESSIONSTART_COOLDOWN_MS,
      nowMs: Date.now(),
      telemetryPath,
    });
    expect(decision.fire).toBe(true);
    expect(decision.skipReason).toBeUndefined();
  });

  it('skips for cooldown when the last fire is within window', async () => {
    const nowMs = Date.parse('2026-04-18T12:00:00Z');
    const lastFiredAt = '2026-04-18T11:00:00Z'; // 1h ago
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({ taskId: 't', triggeredAt: lastFiredAt })}\n`,
    );
    const decision = await evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: 6 * 60 * 60 * 1000, // 6h
      nowMs,
      telemetryPath,
    });
    expect(decision.fire).toBe(false);
    expect(decision.skipReason).toBe('cooldown');
    expect(decision.lastFiredAtMs).toBe(Date.parse(lastFiredAt));
    expect(decision.cooldownRemainingMs).toBe(5 * 60 * 60 * 1000);
  });

  it('fires when last fire is outside the cooldown window', async () => {
    const nowMs = Date.parse('2026-04-18T20:00:00Z');
    const lastFiredAt = '2026-04-18T11:00:00Z'; // 9h ago
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({ taskId: 't', triggeredAt: lastFiredAt })}\n`,
    );
    const decision = await evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: 6 * 60 * 60 * 1000,
      nowMs,
      telemetryPath,
    });
    expect(decision.fire).toBe(true);
    expect(decision.lastFiredAtMs).toBe(Date.parse(lastFiredAt));
  });

  it('respects cooldownMs=0 as "no cooldown check"', async () => {
    const nowMs = Date.parse('2026-04-18T12:00:00Z');
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({ taskId: 't', triggeredAt: '2026-04-18T11:59:59Z' })}\n`,
    );
    const decision = await evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: 0,
      nowMs,
      telemetryPath,
    });
    expect(decision.fire).toBe(true);
  });
});
