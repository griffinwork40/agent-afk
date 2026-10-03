/**
 * Tests for the shared usage core: record merge rules, the ledger
 * (cross-process RMW through StateStore), the single reader, and the single
 * evaluator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeUsageRecords,
  parseUsageRecord,
  usageKey,
  USAGE_STALE_AFTER_MS,
  type UsageRecord,
} from './usage-record.js';
import {
  publishUsage,
  publishingGate,
  readLedgerRecords,
  resetUsageLedgerForTests,
  perMinuteFromRateLimit,
  windowsFromUsageResult,
} from './usage-ledger.js';
import { readUsageRecords, readUsageRecord, collectUsage } from './usage-snapshot.js';
import { bindingWindow, evaluateUsage, levelFor } from './usage-budget.js';
import { recordQuotaSnapshot, resetQuotaCacheForTests } from '../quota-cache.js';
import { StateStore } from '../state/state-store.js';
import { getStateDatabasePath } from '../../paths.js';
import { STALE_AFTER_MS } from '../../cli/quota-indicator.js';

const NOW = 1_800_000_000_000;

function rec(partial: Partial<UsageRecord> = {}): UsageRecord {
  return { v: 1, provider: 'anthropic', account: 'oauth', ...partial };
}

describe('usage-record merge', () => {
  it('newer windows win, older ones never overwrite', () => {
    const newer = rec({ windows: { fiveHour: { utilization: 0.9 }, observedAt: NOW } });
    const older = rec({ windows: { fiveHour: { utilization: 0.1 }, observedAt: NOW - 1000 } });
    expect(mergeUsageRecords(newer, older).windows?.fiveHour?.utilization).toBe(0.9);
    expect(mergeUsageRecords(older, newer).windows?.fiveHour?.utilization).toBe(0.9);
  });

  it('freeze merges by MAX regardless of observation age', () => {
    const a = rec({ perMinute: { frozenUntil: NOW + 60_000, observedAt: NOW - 5000 } });
    const b = rec({ perMinute: { requestsRemaining: 10, observedAt: NOW } });
    const m = mergeUsageRecords(a, b);
    expect(m.perMinute?.frozenUntil).toBe(NOW + 60_000);
    expect(m.perMinute?.requestsRemaining).toBe(10);
  });

  it('parseUsageRecord rejects foreign shapes and clamps utilization', () => {
    expect(parseUsageRecord({ v: 2 })).toBeUndefined();
    expect(parseUsageRecord(null)).toBeUndefined();
    const p = parseUsageRecord({ v: 1, provider: 'p', account: 'a', windows: { observedAt: 1, sevenDayOpus: { utilization: 3 } } });
    expect(p?.windows?.sevenDayOpus?.utilization).toBe(1);
  });

  it('usageKey sanitizes to the StateStore key pattern', () => {
    expect(usageKey('openai', 'api.example.com:8443')).toBe('openai.api.example.com_8443');
  });

  it('status line staleness is the shared constant', () => {
    expect(STALE_AFTER_MS).toBe(USAGE_STALE_AFTER_MS);
  });
});

describe('usage-budget evaluator', () => {
  it('levelFor grades against integer-percent thresholds', () => {
    expect(levelFor(0.79)).toBe('ok');
    expect(levelFor(0.8)).toBe('warn');
    expect(levelFor(1)).toBe('over');
    expect(levelFor(0.9, { warnPct: 90, overPct: 90 })).toBe('over');
  });

  it('bindingWindow picks the most-consumed window across all four', () => {
    const b = bindingWindow({ fiveHour: { utilization: 0.2 }, sevenDayOpus: { utilization: 0.7, resetsAt: 5 }, observedAt: NOW });
    expect(b).toMatchObject({ key: 'sevenDayOpus', label: '7d-opus', pct: 70, resetsAt: 5 });
  });

  it('stale or window-less records are unknown; freezes are reported while in force', () => {
    expect(evaluateUsage(undefined, NOW).level).toBe('unknown');
    const stale = rec({ windows: { fiveHour: { utilization: 0.99 }, observedAt: NOW - USAGE_STALE_AFTER_MS - 1 } });
    expect(evaluateUsage(stale, NOW)).toMatchObject({ level: 'unknown', stale: true });
    const frozen = rec({ perMinute: { frozenUntil: NOW + 1000, observedAt: NOW } });
    expect(evaluateUsage(frozen, NOW)).toMatchObject({ level: 'unknown', frozenUntil: NOW + 1000 });
    expect(evaluateUsage(rec({ perMinute: { frozenUntil: NOW - 1, observedAt: NOW } }), NOW).frozenUntil).toBeUndefined();
  });
});

describe('usage ledger + reader', () => {
  let dir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-usage-ledger-'));
    savedHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = dir;
    resetUsageLedgerForTests();
    resetQuotaCacheForTests();
  });

  afterEach(() => {
    resetUsageLedgerForTests();
    resetQuotaCacheForTests();
    if (savedHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reading with no store file creates no database (nothing to lock on Windows)', () => {
    expect(readLedgerRecords()).toEqual([]);
    expect(readUsageRecord('anthropic', 'oauth')).toBeUndefined();
    expect(existsSync(getStateDatabasePath())).toBe(false);
    // A later publish still creates it.
    publishUsage(rec({ windows: { fiveHour: { utilization: 0.2 }, observedAt: NOW } }), NOW);
    expect(existsSync(getStateDatabasePath())).toBe(true);
    expect(readLedgerRecords()).toHaveLength(1);
  });

  it('publishes and reads back a record', () => {
    publishUsage(rec({ windows: { fiveHour: { utilization: 0.5 }, observedAt: NOW } }), NOW);
    expect(readLedgerRecords()).toHaveLength(1);
    expect(readLedgerRecords()[0]?.windows?.fiveHour?.utilization).toBe(0.5);
  });

  it('a second process (separate connection) sees and cannot regress the record', () => {
    publishUsage(rec({ windows: { fiveHour: { utilization: 0.9 }, observedAt: NOW } }), NOW);
    const other = new StateStore(getStateDatabasePath());
    const row = other.get('usage', 'anthropic.oauth');
    expect(row).not.toBeNull();
    // A stale observation from "another process" arrives late.
    publishUsage(rec({ windows: { fiveHour: { utilization: 0.1 }, observedAt: NOW - 60_000 } }), NOW + 10_000);
    expect(parseUsageRecord(other.get('usage', 'anthropic.oauth')?.value)?.windows?.fiveHour?.utilization).toBe(0.9);
    other.close();
  });

  it('AFK_USAGE_LEDGER_DISABLED=1 turns the ledger off', () => {
    vi.stubEnv('AFK_USAGE_LEDGER_DISABLED', '1');
    publishUsage(rec({ windows: { fiveHour: { utilization: 0.5 }, observedAt: NOW } }), NOW);
    expect(readLedgerRecords()).toEqual([]);
  });

  it('reader merges ledger with the in-process quota cache', () => {
    publishUsage(rec({ perMinute: { requestsRemaining: 7, observedAt: NOW } }), NOW);
    recordQuotaSnapshot({ fiveHourUtilization: 0.4, observedAt: new Date(NOW) });
    const r = readUsageRecord('anthropic', 'oauth');
    expect(r?.perMinute?.requestsRemaining).toBe(7);
    expect(r?.windows?.fiveHour?.utilization).toBe(0.4);
    expect(readUsageRecords()).toHaveLength(1);
  });

  it('publishingGate forwards and mirrors 429 freezes into the ledger', async () => {
    const inner = { acquirePermit: vi.fn(async () => {}), freeze: vi.fn() };
    const gate = publishingGate(inner, 'openai', 'api.openai.com');
    await gate.acquirePermit(10);
    gate.freeze(30_000);
    expect(inner.acquirePermit).toHaveBeenCalledWith(10, undefined);
    expect(inner.freeze).toHaveBeenCalledWith(30_000);
    const r = readLedgerRecords().find((x) => x.provider === 'openai');
    expect(r?.perMinute?.frozenUntil).toBeGreaterThan(Date.now());
  });

  it('collectUsage publishes endpoint windows and reports failures without throwing', async () => {
    const noCodex = async () => ({ kind: 'unavailable', reason: 'no-token', detail: '' }) as const;
    const ok = await collectUsage({ now: NOW, fetchCodex: noCodex, fetchUsage: async () => ({ kind: 'ok', sevenDay: { utilization: 0.3 } }) });
    expect(ok.records[0]?.windows?.sevenDay?.utilization).toBe(0.3);
    expect(readLedgerRecords()[0]?.windows?.sevenDay?.utilization).toBe(0.3);
    const bad = await collectUsage({ now: NOW, fetchCodex: noCodex, fetchUsage: async () => { throw new Error('x'); } });
    expect(bad.anthropic.kind).toBe('unavailable');
  });

  it('collectUsage refreshes Codex in parallel and publishes it under codex/chatgpt-subscription', async () => {
    const out = await collectUsage({
      now: NOW,
      fetchUsage: async () => ({ kind: 'unavailable', reason: 'no-token', detail: '' }),
      fetchCodex: async () => ({ kind: 'ok', sevenDay: { utilization: 0.47 } }),
    });
    expect(out.codex?.kind).toBe('ok');
    expect(readUsageRecord('codex', 'chatgpt-subscription')?.windows?.sevenDay?.utilization).toBe(0.47);
    // A throwing Codex fetch is contained.
    const thrown = await collectUsage({
      now: NOW,
      fetchUsage: async () => ({ kind: 'unavailable', reason: 'no-token', detail: '' }),
      fetchCodex: async () => { throw new Error('boom'); },
    });
    expect(thrown.codex?.kind).toBe('unavailable');
  });

  it('collectUsage skips Codex entirely when includeCodex is false', async () => {
    const fetchCodex = vi.fn(async () => ({ kind: 'ok', sevenDay: { utilization: 0.9 } }) as const);
    const out = await collectUsage({
      now: NOW,
      includeCodex: false,
      fetchCodex,
      fetchUsage: async () => ({ kind: 'unavailable', reason: 'no-token', detail: '' }),
    });
    expect(fetchCodex).not.toHaveBeenCalled();
    expect(out.codex).toBeUndefined();
  });
});

describe('observation adapters', () => {
  it('perMinuteFromRateLimit maps bucket fields', () => {
    expect(perMinuteFromRateLimit({ requestsRemaining: 1, inputTokensRemaining: 2, inputTokensLimit: 3 }, NOW))
      .toEqual({ observedAt: NOW, requestsRemaining: 1, tokensRemaining: 2, tokensLimit: 3 });
  });

  it('windowsFromUsageResult maps all windows, undefined when unavailable', () => {
    expect(windowsFromUsageResult({ kind: 'unavailable', reason: 'no-token', detail: '' }, NOW)).toBeUndefined();
    const w = windowsFromUsageResult({ kind: 'ok', sevenDaySonnet: { utilization: 0.2, resetsAt: new Date(NOW) } }, NOW);
    expect(w?.sevenDaySonnet).toEqual({ utilization: 0.2, resetsAt: NOW });
  });
});
