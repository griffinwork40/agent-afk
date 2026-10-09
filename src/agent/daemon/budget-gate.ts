/**
 * Usage-budget gate for daemon/cron agent tasks.
 *
 * Before an `executor: 'agent'` task starts, the scheduler calls
 * {@link evaluateBudgetGate} for the subscription the daemon's model actually
 * draws on ({@link resolveDaemonUsageTarget}): the Claude windows for an
 * Anthropic model, the ChatGPT (Codex) windows for an OpenAI-compatible model
 * signed in through ChatGPT, nothing otherwise. It refreshes that target
 * through the shared usage reader (`usage/usage-snapshot.ts`: usage endpoint
 * merged with the cross-process ledger, so a reading published by an
 * interactive pane counts too) and grades it with the shared evaluator
 * (`usage/usage-budget.ts`) at `AFK_DAEMON_BUDGET_SKIP_PCT` (default 90). When
 * the binding window is at or over the threshold the task is skipped. A
 * Claude-full daemon running on Codex keeps working, and vice versa.
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
import { CODEX_SUBSCRIPTION } from '../usage/codex-usage.js';
import { providerForModel } from '../providers/index.js';
import { resolveOpenAIAuth } from '../providers/openai-compatible/auth.js';
import { evaluateUsage, type BindingWindow } from '../usage/usage-budget.js';
import { describeBindingWindow } from '../usage/usage-formatter.js';
import { errorMessage } from '../../utils/errors.js';

/** Result when the gate allows the task to proceed. */
interface BudgetGatePass {
  readonly skip: false;
}

/** Result when the gate decides the task should be skipped. */
export interface BudgetGateSkip {
  readonly skip: true;
  /** Ledger provider id of the graded subscription (`anthropic` or `codex`). */
  readonly provider: string;
  /** The window that tripped the threshold. */
  readonly binding: BindingWindow;
}

export type BudgetGateResult = BudgetGatePass | BudgetGateSkip;

/** A subscription to grade (ledger provider/account). */
export interface UsageTarget {
  readonly provider: string;
  readonly account: string;
}

export interface BudgetGateOptions {
  /** Skip threshold, 0–100. Defaults to `AFK_DAEMON_BUDGET_SKIP_PCT` or 90. */
  readonly skipPct?: number;
  /**
   * Subscription to grade. Omitted = the Claude subscription (legacy default);
   * `null` = the daemon's model draws on no windowed subscription, so pass.
   */
  readonly target?: UsageTarget | null;
  /** Injectable for tests. Defaults to the real OAuth usage endpoint fetch. */
  readonly fetchUsage?: (opts?: FetchSubscriptionUsageOptions) => Promise<UsageResult>;
  /** Injectable for tests. Defaults to the ChatGPT usage endpoint fetch. */
  readonly fetchCodex?: () => Promise<UsageResult>;
  readonly now?: number;
}

/**
 * Which subscription a daemon session on `model` draws down. Anthropic models
 * use the Claude windows; OpenAI-compatible models use the Codex windows only
 * when their auth resolves to the ChatGPT sign-in (an API key has per-minute
 * limits, not subscription windows). Anything else returns null (not gated).
 *
 * @param chatgptSignedIn Injectable for tests; defaults to the provider's own
 *   auth resolution for `apiKey` (the daemon's configured key, if any).
 */
export function resolveDaemonUsageTarget(
  model: string | undefined,
  apiKey?: string,
  chatgptSignedIn: () => boolean = () => resolveOpenAIAuth(apiKey).source === 'chatgpt-oauth',
): UsageTarget | null {
  const provider = providerForModel(model ?? 'sonnet');
  if (provider === 'anthropic-direct') return ANTHROPIC_OAUTH;
  if (provider === 'openai-compatible') {
    try {
      return chatgptSignedIn() ? CODEX_SUBSCRIPTION : null;
    } catch {
      return null;
    }
  }
  return null;
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
  const target = options.target === undefined ? ANTHROPIC_OAUTH : options.target;
  if (target === null) return { skip: false };
  const skipPct = resolveSkipPct(options.skipPct);
  // When skipPct reaches 100 no real utilization can exceed it, so skip the
  // network round-trip entirely and pass unconditionally.
  if (skipPct >= 100) return { skip: false };
  const now = options.now ?? Date.now();
  const isCodex = target.provider === CODEX_SUBSCRIPTION.provider;
  try {
    const { records } = await collectUsage({
      now,
      // Refresh only the subscription this gate grades.
      includeClaude: !isCodex,
      includeCodex: isCodex,
      ...(options.fetchUsage ? { fetchUsage: options.fetchUsage } : {}),
      ...(options.fetchCodex ? { fetchCodex: options.fetchCodex } : {}),
    });
    const rec = records.find((r) => r.provider === target.provider && r.account === target.account && r.windows !== undefined);
    const ev = evaluateUsage(rec, now, { warnPct: skipPct, overPct: skipPct });
    if (ev.level === 'over' && ev.binding !== undefined) {
      return { skip: true, provider: target.provider, binding: ev.binding };
    }
  } catch (err) {
    // Fail-open (see module Invariant).
    console.debug(`[daemon] budget-gate: collectUsage failed, passing task through (${errorMessage(err)})`);
  }
  return { skip: false };
}

/** One-line reason, shared by the telemetry record and the Telegram notice. */
export function describeBudgetSkip(skip: BudgetGateSkip, now: number = Date.now()): string {
  return describeBindingWindow(skip.provider, skip.binding, now);
}

/**
 * Plain-text Telegram notice for the FIRST skip of a budget episode (no markup,
 * safe in every parse mode). Later skips in the same episode are suppressed by
 * {@link BudgetAlertLatch}, so the message speaks for all of them.
 */
export function formatBudgetSkipMessage(skip: BudgetGateSkip, taskId: string, now: number = Date.now()): string {
  return (
    `[daemon] Usage over budget: ${describeBudgetSkip(skip, now)}\n` +
    `Skipping scheduled agent tasks on this subscription until it drops below the threshold ` +
    `(first skipped: "${taskId}"). Further skips are logged to telemetry without alerts.`
  );
}

/**
 * One Telegram alert per budget episode instead of one per skipped task.
 *
 * An episode is (provider, binding window, reset time). The first skip in an
 * episode notifies; later skips in it do not. Any pass clears the latch, so the
 * next crossing alerts again; a new reset time (the window rolled over and
 * filled again) is a new episode.
 *
 * Invariant: daemon-process state only. A daemon restart re-alerts once, which
 * is the intended trade (never silent after a restart, never a flood).
 */
export class BudgetAlertLatch {
  private alerted: string | undefined;

  /** True when this skip opens a new episode (send the alert). */
  shouldAlert(skip: BudgetGateSkip): boolean {
    const key = `${skip.provider}|${skip.binding.label}|${skip.binding.resetsAt ?? 'none'}`;
    if (this.alerted === key) return false;
    this.alerted = key;
    return true;
  }

  /** A task passed the gate: the episode is over. */
  clear(): void {
    this.alerted = undefined;
  }
}
