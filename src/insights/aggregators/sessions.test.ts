/**
 * Unit tests for the sessions aggregator.
 *
 * Strategy: synthetic temp-dir fixtures, no real AFK_HOME reads.
 * Each test creates minimal session JSON files and verifies aggregate outputs.
 *
 * Privacy assertion: no output field may contain a telegramChatId value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateSessions } from './sessions.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `afk-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpRoot, 'state', 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSession(name: string, data: Record<string, unknown>): void {
  writeFileSync(
    join(tmpRoot, 'state', 'sessions', `${name}.json`),
    JSON.stringify(data),
    'utf-8',
  );
}

function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'test-session-1',
    model: 'claude-3-5-sonnet',
    source: 'cli',
    startedAt: Date.now() - 1000, // 1s ago — inside any reasonable window
    totalCostUsd: 0.05,
    // Real session sidecars store ONLY a combined total — no input/output
    // split, no `usage` object. The per-direction split lives in traces.
    totalTokens: 300,
    // telegramChatId intentionally present to test privacy
    telegramChatId: 12345678,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregateSessions', () => {
  it('empty directory → zero aggregates, no throw', () => {
    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalSessions).toBe(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(Object.keys(result.byDay)).toHaveLength(0);
    expect(Object.keys(result.byModel)).toHaveLength(0);
    expect(Object.keys(result.bySurface)).toHaveLength(0);
  });

  it('returns zero aggregates when sessions dir does not exist', () => {
    const result = aggregateSessions({ days: 30, afkHome: '/nonexistent/path/xyz' });
    expect(result.totalSessions).toBe(0);
  });

  it('session with startedAt before cutoff is excluded', () => {
    const oldStartedAt = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40d ago
    writeSession('old', makeSession({ startedAt: oldStartedAt }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalSessions).toBe(0);
    expect(result.totalCostUsd).toBe(0);
  });

  it('session at exactly 30 days ago (boundary) is excluded', () => {
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    // Strictly before cutoff
    writeSession('boundary', makeSession({ startedAt: cutoffMs - 1 }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalSessions).toBe(0);
  });

  it('session after cutoff is included', () => {
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    writeSession('recent', makeSession({ startedAt: cutoffMs + 1000 }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalSessions).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.05);
  });

  it('mtime pre-filter: a sidecar last modified before the cutoff is skipped without being read', () => {
    // Regression guard for the mtime pre-filter (mirrors the traces aggregator).
    // A sidecar's mtime is always >= its session's startedAt, so a file whose
    // mtime predates the window can be skipped without reading it. We give the
    // file a RECENT startedAt but an OLD mtime: with the pre-filter active the
    // session is skipped (0); were the pre-filter removed, the file would be
    // read and the recent startedAt would wrongly include it (1).
    const filePath = join(tmpRoot, 'state', 'sessions', 'stale-mtime.json');
    writeFileSync(filePath, JSON.stringify(makeSession({ startedAt: Date.now() })), 'utf-8');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(filePath, old, old);

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalSessions).toBe(0);
  });

  it('two sessions: model breakdown sums correctly', () => {
    writeSession('s1', makeSession({ model: 'claude-3-5-sonnet', totalCostUsd: 0.10 }));
    writeSession('s2', makeSession({ model: 'claude-3-opus', totalCostUsd: 0.25 }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalSessions).toBe(2);
    expect(result.byModel['claude-3-5-sonnet']?.sessions).toBe(1);
    expect(result.byModel['claude-3-5-sonnet']?.costUsd).toBeCloseTo(0.10);
    expect(result.byModel['claude-3-opus']?.sessions).toBe(1);
    expect(result.byModel['claude-3-opus']?.costUsd).toBeCloseTo(0.25);
  });

  it('surface breakdown: telegram vs cli', () => {
    writeSession('cli-session', makeSession({ source: 'cli', totalCostUsd: 0.05 }));
    writeSession('tg-session', makeSession({ source: 'telegram', totalCostUsd: 0.15 }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.bySurface['cli']?.sessions).toBe(1);
    expect(result.bySurface['telegram']?.sessions).toBe(1);
    expect(result.bySurface['telegram']?.costUsd).toBeCloseTo(0.15);
  });

  it('privacy: no output field contains telegramChatId value', () => {
    const FAKE_CHAT_ID = 99887766;
    writeSession('tg', makeSession({ telegramChatId: FAKE_CHAT_ID, source: 'telegram' }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(String(FAKE_CHAT_ID));
  });

  it('cost sum spot-check: aggregate.totalCostUsd equals sum of session costs', () => {
    const costs = [0.05, 0.12, 0.03];
    costs.forEach((c, i) => writeSession(`s${i}`, makeSession({ totalCostUsd: c })));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    const expectedTotal = costs.reduce((a, b) => a + b, 0);
    expect(result.totalCostUsd).toBeCloseTo(expectedTotal);
  });

  it('malformed JSON file → skipped, no throw', () => {
    writeFileSync(
      join(tmpRoot, 'state', 'sessions', 'bad.json'),
      '{ this is not valid json }',
      'utf-8',
    );
    writeSession('good', makeSession());

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    // Only the valid session is counted
    expect(result.totalSessions).toBe(1);
  });

  it('session without startedAt → skipped, no throw', () => {
    writeSession('no-ts', { sessionId: 'x', model: 'opus', totalCostUsd: 1.0 });

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalSessions).toBe(0);
  });

  it('combined token total is summed from the sidecar totalTokens field', () => {
    writeSession('s1', makeSession({ totalTokens: 1700 }));
    writeSession('s2', makeSession({ totalTokens: 1100 }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalTokens).toBe(2800);
  });

  it('missing totalTokens field → contributes 0, no NaN', () => {
    writeSession('s1', makeSession({ totalTokens: undefined }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalTokens).toBe(0);
    expect(result.totalSessions).toBe(1);
  });

  it('session with unknown model defaults to "unknown" key', () => {
    writeSession('no-model', makeSession({ model: '' }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.byModel['unknown']).toBeDefined();
  });

  it('day breakdown groups sessions by date correctly', () => {
    const nowMs = Date.now();
    // Session from today
    writeSession('today', makeSession({ startedAt: nowMs - 1000, totalCostUsd: 0.10 }));
    // Session from 2 days ago
    writeSession('past', makeSession({
      startedAt: nowMs - 2 * 24 * 60 * 60 * 1000,
      totalCostUsd: 0.20,
    }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(Object.keys(result.byDay)).toHaveLength(2);
    expect(result.totalSessions).toBe(2);
  });

  it('session with zero cost still counted in session totals', () => {
    writeSession('zero-cost', makeSession({ totalCostUsd: 0 }));

    const result = aggregateSessions({ days: 30, afkHome: tmpRoot });
    expect(result.totalSessions).toBe(1);
    expect(result.totalCostUsd).toBe(0);
  });
});
