/**
 * Usage-budget gate for daemon/cron agent tasks.
 *
 * Before an `executor: 'agent'` task starts, the scheduler calls
 * {@link evaluateBudgetGate}. It refreshes the Claude subscription windows
 * through the shared usage reader (`usage/usage-snapshot.ts` — OAuth usage
 * endpoint merged with the cross-process ledger, so a reading published by an
 * interactive pane counts too) and grades them with the shared evaluator
 * (`usage/usage-budget.ts`) at `AFK_DAEMON_BUDGET_SKIP_PCT` (default 90). When
 * the binding window is at or over the threshold the task is skipped.
 *
 * Shell and builtin tasks never reach this gate (they use no model quota).
 *
 * Invariant: fail-open. No token, a network error, a stale-only reading, or
 * an unexpected throw all PASS — a monitoring hiccup must never silently stop
 * every scheduled job. `AFK_DAEMON_BUDGET_GATE_DISABLED=1` skips the check
 * entirely (no network round-trip).
 *
 * @module agent/daemon/budget-gate
 */

import type { FetchSubscriptionUsageOptions, UsageResult } from '../subscription-usage.js';
import { env } from '../../config/env.js';
import { collectUsage, ANTHROPIC_OAUTH } from '../usage/usage-snapshot.js';
import { evaluateUsage, type BindingWindow } from '../usage/usage-budget.js';
import { describeBindingWindow } from '../usage/usage-formatter.js';

/** Result when the gate allows the task to proceed. */
export interface BudgetGatePass {
  readonly skip: false;
}

/** Result when the gate decides the task should be skipped. */
export interface BudgetGateSkip {
  readonly skip: true;
  /** Ledger provider id; always `anthropic` today (the only windowed provider). */
  readonly provider: string;
  /** The window that tripped the threshold. */
  readonly binding: BindingWindow;
}

export type BudgetGateResult = BudgetGatePass | BudgetGateSkip;

export interface BudgetGateOptions {
  /** Skip threshold, 0–100. Defaults to `AFK_DAEMON_BUDGET_SKIP_PCT` or 90. */
  readonly skipPct?: number;
  /** Injectable for tests. Defaults to the real OAuth usage endpoint fetch. */
  readonly fetchUsage?: (opts?: FetchSubscriptionUsageOptions) => Promise<UsageResult>;
  readonly now?: number;
}

const DEFAULT_SKIP_PCT = 90;

function resolveSkipPct(override?: number): number {
  if (override !== undefined && Number.isFinite(override)) return Math.min(100, Math.max(0, override));
  const parsed = Number(env.AFK_DAEMON_BUDGET_SKIP_PCT);
  if (env.AFK_DAEMON_BUDGET_SKIP_PCT !== undefined && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
    return parsed;
  }
  return DEFAULT_SKIP_PCT;
}

/** Decide whether a scheduled agent task should be skipped for usage. Never throws. */
export async function evaluateBudgetGate(options: BudgetGateOptions = {}): Promise<BudgetGateResult> {
  if (env.AFK_DAEMON_BUDGET_GATE_DISABLED === '1') return { skip: false };
  const skipPct = resolveSkipPct(options.skipPct);
  const now = options.now ?? Date.now();
  try {
    const { records } = await collectUsage({ now, ...(options.fetchUsage ? { fetchUsage: options.fetchUsage } : {}) });
    const rec = records.find((r) => r.provider === ANTHROPIC_OAUTH.provider && r.windows !== undefined);
    const ev = evaluateUsage(rec, now, { warnPct: skipPct, overPct: skipPct });
    if (ev.level === 'over' && ev.binding !== undefined) {
      return { skip: true, provider: ANTHROPIC_OAUTH.provider, binding: ev.binding };
    }
  } catch {
    // Fail-open (see module Invariant).
  }
  return { skip: false };
}

/** One-line reason, shared by the telemetry record and the Telegram notice. */
export function describeBudgetSkip(skip: BudgetGateSkip, now: number = Date.now()): string {
  return describeBindingWindow(skip.provider, skip.binding, now);
}

/** Plain-text Telegram notice for a budget skip (no markup — safe in every parse mode). */
export function formatBudgetSkipMessage(skip: BudgetGateSkip, taskId: string, now: number = Date.now()): string {
  return `[daemon] Skipped task "${taskId}" — usage over budget\n${describeBudgetSkip(skip, now)}`;
}
