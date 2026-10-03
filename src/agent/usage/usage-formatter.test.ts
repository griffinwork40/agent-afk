/**
 * Tests for the shared usage formatter (`afk usage` JSON/text, runtime-state
 * entries, one-line notices).
 */

import { describe, it, expect } from 'vitest';
import {
  compactUsageEntries,
  describeBindingWindow,
  errorProviderSummary,
  formatUsageSummaryText,
  summarizeUsageRecord,
  unknownProviderSummary,
  usageRows,
  type UsageSummary,
} from './usage-formatter.js';
import { USAGE_STALE_AFTER_MS, type UsageRecord } from './usage-record.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');

function rec(partial: Partial<UsageRecord> = {}): UsageRecord {
  return { v: 1, provider: 'anthropic', account: 'oauth', ...partial };
}

describe('summarizeUsageRecord', () => {
  it('returns unknown for a record with no observations', () => {
    expect(summarizeUsageRecord(rec(), NOW).status).toBe('unknown');
  });

  it('maps windows with pct and reset countdown', () => {
    const s = summarizeUsageRecord(rec({
      windows: { fiveHour: { utilization: 0.74, resetsAt: NOW + 130 * 60_000 }, sevenDay: { utilization: 0.12 }, observedAt: NOW - 30_000 },
    }), NOW);
    expect(s.status).toBe('ok');
    expect(s.ageMs).toBe(30_000);
    expect(s.fiveHour).toMatchObject({ utilizationPct: 74, resetsIn: '2h10m' });
    expect(s.sevenDay?.utilizationPct).toBe(12);
    expect(s.sevenDay?.resetsIn).toBeUndefined();
  });

  it('omits resetsIn for a reset already passed', () => {
    const s = summarizeUsageRecord(rec({ windows: { fiveHour: { utilization: 0.5, resetsAt: NOW - 1 }, observedAt: NOW } }), NOW);
    expect(s.fiveHour?.resetsAtMs).toBe(NOW - 1);
    expect(s.fiveHour?.resetsIn).toBeUndefined();
  });

  it('marks stale past the shared cutoff', () => {
    const s = summarizeUsageRecord(rec({ windows: { fiveHour: { utilization: 0.5 }, observedAt: NOW - USAGE_STALE_AFTER_MS - 1 } }), NOW);
    expect(s.status).toBe('stale');
  });

  it('includes per-minute numbers and an active freeze only', () => {
    const s = summarizeUsageRecord(rec({ perMinute: { requestsRemaining: 40, requestsLimit: 50, frozenUntil: NOW + 120_000, observedAt: NOW } }), NOW);
    expect(s.perMinute).toMatchObject({ requestsRemaining: 40, requestsLimit: 50, frozenUntilMs: NOW + 120_000, frozenFor: '2m' });
    const past = summarizeUsageRecord(rec({ perMinute: { frozenUntil: NOW - 1, observedAt: NOW } }), NOW);
    expect(past.perMinute).toBeUndefined();
  });
});

describe('compactUsageEntries (get_runtime_state)', () => {
  it('produces one compact entry per record', () => {
    const entries = compactUsageEntries([
      rec({ windows: { fiveHour: { utilization: 0.74 }, sevenDay: { utilization: 0.12 }, observedAt: NOW }, perMinute: { frozenUntil: NOW + 5000, observedAt: NOW } }),
    ], NOW);
    expect(entries).toEqual([{ provider: 'anthropic', account: 'oauth', status: 'ok', fiveHourPct: 74, sevenDayPct: 12, frozenUntilMs: NOW + 5000 }]);
  });
});

describe('describeBindingWindow', () => {
  it('names Claude and includes the countdown when known', () => {
    expect(describeBindingWindow('anthropic', { key: 'fiveHour', label: '5h', utilization: 0.86, pct: 86, resetsAt: NOW + 12 * 60_000 }, NOW))
      .toBe('Claude 5h window at 86%, resets in 12m');
    expect(describeBindingWindow('openai', { key: 'sevenDay', label: '7d', utilization: 1, pct: 100 }, NOW))
      .toBe('openai 7d window at 100%');
  });
});

describe('formatUsageSummaryText / usageRows', () => {
  it('renders unknown and error providers', () => {
    const summary: UsageSummary = {
      asOfMs: NOW,
      providers: [unknownProviderSummary('codex', 'subscription'), errorProviderSummary('anthropic', 'oauth', 'HTTP 503.')],
    };
    const lines = formatUsageSummaryText(summary);
    expect(lines).toContain('codex / subscription [unknown]');
    expect(lines.some((l) => l.includes('No usage data'))).toBe(true);
    expect(lines).toContain('anthropic / oauth [error]');
    expect(lines.some((l) => l.includes('HTTP 503.'))).toBe(true);
  });

  it('grades window rows with the shared evaluator', () => {
    const p = summarizeUsageRecord(rec({ windows: { fiveHour: { utilization: 0.85 }, sevenDay: { utilization: 0.2 }, observedAt: NOW } }), NOW);
    const rows = usageRows(p);
    expect(rows.find((r) => r.label === '5h utilization')?.level).toBe('warn');
    expect(rows.find((r) => r.label === '7d utilization')?.level).toBe('ok');
  });

  it('renders freeze and per-minute rows', () => {
    const p = summarizeUsageRecord(rec({ perMinute: { frozenUntil: NOW + 42_000, tokensRemaining: 9, observedAt: NOW } }), NOW);
    const lines = formatUsageSummaryText({ asOfMs: NOW, providers: [p] });
    expect(lines.some((l) => l.includes('Frozen (429)'))).toBe(true);
    expect(lines.some((l) => l.includes('Tokens/min remaining: 9'))).toBe(true);
  });

  it('summary is JSON round-trippable', () => {
    const summary: UsageSummary = { asOfMs: NOW, providers: [summarizeUsageRecord(rec({ windows: { fiveHour: { utilization: 0.45 }, observedAt: NOW } }), NOW)] };
    const json = JSON.parse(JSON.stringify(summary)) as UsageSummary;
    expect(json.providers[0]?.fiveHour?.utilizationPct).toBe(45);
  });
});
