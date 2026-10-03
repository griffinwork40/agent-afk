/**
 * Tests for the daemon budget gate — unit tests only.
 *
 * Scheduler integration tests (shell-never-gated, notification, lease-invariant)
 * are in budget-gate.scheduler.test.ts which mocks budget-gate.js itself.
 *
 * @module agent/daemon/budget-gate.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetQuotaCacheForTests } from '../quota-cache.js';
import { publishUsage, resetUsageLedgerForTests } from '../usage/usage-ledger.js';
import {
  evaluateBudgetGate,
  formatBudgetSkipMessage,
  type BudgetGateSkip,
} from './budget-gate.js';
import type { UsageResult } from '../subscription-usage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResult(utilization: number, label: 'fiveHour' | 'sevenDay' = 'fiveHour'): UsageResult {
  return {
    kind: 'ok',
    [label]: { utilization },
  } as UsageResult;
}

function makeUnavailableResult(): UsageResult {
  return { kind: 'unavailable', reason: 'no-token', detail: 'no token' };
}

// ---------------------------------------------------------------------------
// evaluateBudgetGate unit tests
// ---------------------------------------------------------------------------

describe('evaluateBudgetGate', () => {
  let savedDisabled: string | undefined;
  let savedSkipPct: string | undefined;

  beforeEach(() => {
    savedDisabled = process.env['AFK_DAEMON_BUDGET_GATE_DISABLED'];
    savedSkipPct = process.env['AFK_DAEMON_BUDGET_SKIP_PCT'];
    delete process.env['AFK_DAEMON_BUDGET_GATE_DISABLED'];
    delete process.env['AFK_DAEMON_BUDGET_SKIP_PCT'];
    // Isolate from the shared ledger: each case sees only its own fetch result.
    vi.stubEnv('AFK_USAGE_LEDGER_DISABLED', '1');
    resetQuotaCacheForTests();
  });

  afterEach(() => {
    if (savedDisabled === undefined) delete process.env['AFK_DAEMON_BUDGET_GATE_DISABLED'];
    else process.env['AFK_DAEMON_BUDGET_GATE_DISABLED'] = savedDisabled;
    if (savedSkipPct === undefined) delete process.env['AFK_DAEMON_BUDGET_SKIP_PCT'];
    else process.env['AFK_DAEMON_BUDGET_SKIP_PCT'] = savedSkipPct;
  });

  it('skips when any window is at or above the threshold (default 90%)', async () => {
    const result = await evaluateBudgetGate({
      skipPct: 90,
      fetchUsage: async () => makeOkResult(0.92),
    });
    expect(result.skip).toBe(true);
    if (result.skip) {
      expect(result.provider).toBe('anthropic');
      expect(result.binding.utilization).toBeCloseTo(0.92);
      expect(result.binding.label).toBe('5h');
    }
  });

  it('passes when all windows are below the threshold', async () => {
    const result = await evaluateBudgetGate({
      skipPct: 90,
      fetchUsage: async () => makeOkResult(0.85),
    });
    expect(result.skip).toBe(false);
  });

  it('passes (fail-open) when usage is unavailable', async () => {
    const result = await evaluateBudgetGate({
      fetchUsage: async () => makeUnavailableResult(),
    });
    expect(result.skip).toBe(false);
  });

  it('passes (fail-open) when fetchUsage rejects unexpectedly', async () => {
    const result = await evaluateBudgetGate({
      fetchUsage: async () => { throw new Error('network down'); },
    });
    expect(result.skip).toBe(false);
  });

  it('respects explicit skipPct option', async () => {
    // 82% >= 80% → skip
    const result = await evaluateBudgetGate({
      skipPct: 80,
      fetchUsage: async () => makeOkResult(0.82),
    });
    expect(result.skip).toBe(true);
  });

  it('passes when skipPct is 100 (disabled via threshold)', async () => {
    const result = await evaluateBudgetGate({
      skipPct: 100,
      fetchUsage: async () => makeOkResult(0.99),
    });
    expect(result.skip).toBe(false);
  });

  it('env opt-out: AFK_DAEMON_BUDGET_GATE_DISABLED=1 skips network call and passes', async () => {
    process.env['AFK_DAEMON_BUDGET_GATE_DISABLED'] = '1';
    let called = false;
    const result = await evaluateBudgetGate({
      fetchUsage: async () => { called = true; return makeOkResult(1.0); },
    });
    expect(result.skip).toBe(false);
    expect(called).toBe(false);
  });

  it('includes resetsAt when the window provides it', async () => {
    const resetsAt = new Date('2026-10-03T15:00:00Z');
    const result = await evaluateBudgetGate({
      skipPct: 90,
      fetchUsage: async () => ({
        kind: 'ok',
        fiveHour: { utilization: 0.95, resetsAt },
      }),
    });
    expect(result.skip).toBe(true);
    if (result.skip) {
      expect(result.binding.resetsAt).toBe(resetsAt.getTime());
    }
  });

  it('gates on a reading published by another process when the endpoint is unavailable', async () => {
    vi.stubEnv('AFK_USAGE_LEDGER_DISABLED', '');
    resetUsageLedgerForTests();
    const now = Date.now();
    publishUsage({ v: 1, provider: 'anthropic', account: 'oauth', windows: { fiveHour: { utilization: 0.97 }, observedAt: now } }, now);
    const result = await evaluateBudgetGate({ fetchUsage: async () => makeUnavailableResult(), now });
    expect(result.skip).toBe(true);
    resetUsageLedgerForTests();
  });

  it('picks the highest-utilization window', async () => {
    const result = await evaluateBudgetGate({
      skipPct: 90,
      fetchUsage: async () => ({
        kind: 'ok',
        fiveHour: { utilization: 0.70 },
        sevenDay: { utilization: 0.95 },
        sevenDaySonnet: { utilization: 0.60 },
      }),
    });
    expect(result.skip).toBe(true);
    if (result.skip) {
      expect(result.binding.label).toBe('7d');
      expect(result.binding.utilization).toBeCloseTo(0.95);
    }
  });
});

// ---------------------------------------------------------------------------
// formatBudgetSkipMessage
// ---------------------------------------------------------------------------

describe('formatBudgetSkipMessage', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z');

  it('formats a skip with a reset countdown', () => {
    const skip: BudgetGateSkip = {
      skip: true,
      provider: 'anthropic',
      binding: { key: 'fiveHour', label: '5h', utilization: 0.94, pct: 94, resetsAt: NOW + 90 * 60_000 },
    };
    const msg = formatBudgetSkipMessage(skip, 'my-task', NOW);
    expect(msg).toContain('my-task');
    expect(msg).toContain('Claude 5h window at 94%, resets in 1h30m');
  });

  it('formats a skip without resetsAt', () => {
    const skip: BudgetGateSkip = {
      skip: true,
      provider: 'anthropic',
      binding: { key: 'sevenDay', label: '7d', utilization: 0.91, pct: 91 },
    };
    const msg = formatBudgetSkipMessage(skip, 'task-2', NOW);
    expect(msg).toContain('91%');
    expect(msg).not.toContain('resets');
  });
});
