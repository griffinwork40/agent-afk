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

  it('returns null when file does not exist', () => {
    expect(readLastTickTime('any', telemetryPath)).toBeNull();
  });

  it('returns null when file has no matching taskId', () => {
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({ taskId: 'other', triggeredAt: '2026-04-18T10:00:00Z' })}\n`,
    );
    expect(readLastTickTime('missing', telemetryPath)).toBeNull();
  });

  it('returns the most recent triggeredAt for the task', () => {
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
    expect(readLastTickTime('t', telemetryPath)).toBe(Date.parse(later));
  });

  it('ignores malformed lines', () => {
    writeFileSync(
      telemetryPath,
      [
        'not-json',
        JSON.stringify({ taskId: 't', triggeredAt: '2026-04-18T09:00:00Z' }),
        '{incomplete',
      ].join('\n') + '\n',
    );
    expect(readLastTickTime('t', telemetryPath)).toBe(Date.parse('2026-04-18T09:00:00Z'));
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

  it('fires when no prior telemetry', () => {
    const decision = evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: DEFAULT_SESSIONSTART_COOLDOWN_MS,
      nowMs: Date.now(),
      telemetryPath,
    });
    expect(decision.fire).toBe(true);
    expect(decision.skipReason).toBeUndefined();
  });

  it('skips for cooldown when the last fire is within window', () => {
    const nowMs = Date.parse('2026-04-18T12:00:00Z');
    const lastFiredAt = '2026-04-18T11:00:00Z'; // 1h ago
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({ taskId: 't', triggeredAt: lastFiredAt })}\n`,
    );
    const decision = evaluateSessionStartGates({
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

  it('fires when last fire is outside the cooldown window', () => {
    const nowMs = Date.parse('2026-04-18T20:00:00Z');
    const lastFiredAt = '2026-04-18T11:00:00Z'; // 9h ago
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({ taskId: 't', triggeredAt: lastFiredAt })}\n`,
    );
    const decision = evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: 6 * 60 * 60 * 1000,
      nowMs,
      telemetryPath,
    });
    expect(decision.fire).toBe(true);
    expect(decision.lastFiredAtMs).toBe(Date.parse(lastFiredAt));
  });

  it('respects cooldownMs=0 as "no cooldown check"', () => {
    const nowMs = Date.parse('2026-04-18T12:00:00Z');
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({ taskId: 't', triggeredAt: '2026-04-18T11:59:59Z' })}\n`,
    );
    const decision = evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: 0,
      nowMs,
      telemetryPath,
    });
    expect(decision.fire).toBe(true);
  });
});
