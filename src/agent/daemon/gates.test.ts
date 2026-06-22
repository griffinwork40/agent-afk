/**
 * Tests for Phase 6 sessionstart gates — cooldown + brief-queue.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countPendingBriefs,
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

describe('countPendingBriefs', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 0 when the directory does not exist', () => {
    expect(countPendingBriefs(join(dir, 'missing'))).toBe(0);
  });

  it('returns 0 when the directory is empty', () => {
    expect(countPendingBriefs(dir)).toBe(0);
  });

  it('counts top-level .md files, ignoring dotfiles and non-md files', () => {
    writeFileSync(join(dir, 'brief-1.md'), '');
    writeFileSync(join(dir, 'brief-2.md'), '');
    writeFileSync(join(dir, '.hidden'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    expect(countPendingBriefs(dir)).toBe(2);
  });

  it('does NOT count subdirectories (consumed/ and failed/ lifecycle bins)', () => {
    // Regression: the daemon's briefs dir always holds consumed/ and failed/
    // subdirs once any brief has been processed. Counting them as pending
    // briefs would permanently trip the sessionstart gate's briefs_pending
    // skip even when zero real briefs remain. Only top-level .md files count,
    // and .md files nested inside those bins must not leak into the count.
    mkdirSync(join(dir, 'consumed'));
    mkdirSync(join(dir, 'failed'));
    writeFileSync(join(dir, 'consumed', 'old-brief.md'), '');
    expect(countPendingBriefs(dir)).toBe(0);

    writeFileSync(join(dir, 'real-brief.md'), '');
    expect(countPendingBriefs(dir)).toBe(1);
  });
});

describe('evaluateSessionStartGates', () => {
  let dir: string;
  let telemetryPath: string;
  let briefsDir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'telemetry.jsonl');
    briefsDir = join(dir, 'briefs');
    mkdirSync(briefsDir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires when no prior telemetry and no briefs', () => {
    const decision = evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: DEFAULT_SESSIONSTART_COOLDOWN_MS,
      nowMs: Date.now(),
      telemetryPath,
      briefsDir,
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
      briefsDir,
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
      briefsDir,
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
      briefsDir,
    });
    expect(decision.fire).toBe(true);
  });

  it('skips when a brief is pending even after cooldown passes', () => {
    writeFileSync(join(briefsDir, 'brief-pending.md'), '');
    const decision = evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: DEFAULT_SESSIONSTART_COOLDOWN_MS,
      nowMs: Date.now(),
      telemetryPath,
      briefsDir,
    });
    expect(decision.fire).toBe(false);
    expect(decision.skipReason).toBe('briefs_pending');
    expect(decision.pendingBriefCount).toBe(1);
  });

  it('cooldown is checked before brief queue — cooldown miss reported, not briefs', () => {
    // Both gates would fail; cooldown gate fires first.
    const nowMs = Date.parse('2026-04-18T12:00:00Z');
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({ taskId: 't', triggeredAt: '2026-04-18T11:00:00Z' })}\n`,
    );
    writeFileSync(join(briefsDir, 'brief.md'), '');
    const decision = evaluateSessionStartGates({
      taskId: 't',
      cooldownMs: 6 * 60 * 60 * 1000,
      nowMs,
      telemetryPath,
      briefsDir,
    });
    expect(decision.fire).toBe(false);
    expect(decision.skipReason).toBe('cooldown');
  });
});
