/**
 * The single usage evaluator: turns a {@link UsageRecord} into a level
 * (`ok` / `warn` / `over` / `unknown`) against percentage thresholds.
 *
 * Every surface that grades usage goes through here — the fan-out notice
 * (`tools/usage-notice.ts`), the daemon budget gate (`daemon/budget-gate.ts`),
 * and the `afk usage` row colouring (`usage-formatter.ts`) — so "how full is
 * full" and "how old is too old" are decided in exactly one place.
 *
 * Pure module: no I/O, no module state.
 *
 * @module agent/usage/usage-budget
 */

import {
  USAGE_STALE_AFTER_MS,
  WINDOW_KEYS,
  WINDOW_LABELS,
  type UsageRecord,
  type WindowKey,
  type WindowsObservation,
} from './usage-record.js';

export type UsageLevel = 'ok' | 'warn' | 'over' | 'unknown';

/** Integer percentages (0..100). `warn` <= `over`. */
export interface UsageThresholds {
  readonly warnPct: number;
  readonly overPct: number;
}

/** Fan-out notice / `afk usage` defaults: warn at 80%, over at 100%. */
export const DEFAULT_USAGE_THRESHOLDS: UsageThresholds = { warnPct: 80, overPct: 100 };

/** The most-consumed window — the one that will bind first. */
export interface BindingWindow {
  readonly key: WindowKey;
  /** Short label, e.g. `5h`, `7d-opus`. */
  readonly label: string;
  /** Fraction consumed, 0..1. */
  readonly utilization: number;
  /** `Math.round(utilization * 100)`. */
  readonly pct: number;
  /** Epoch ms of the reset, when reported. */
  readonly resetsAt?: number;
}

export interface UsageEvaluation {
  readonly level: UsageLevel;
  /** True when windows exist but are older than {@link USAGE_STALE_AFTER_MS}. */
  readonly stale: boolean;
  readonly binding?: BindingWindow;
  /** Active 429 freeze deadline (epoch ms), when one is in force at `now`. */
  readonly frozenUntil?: number;
}

/** Grade one utilization fraction. */
export function levelFor(utilization: number, t: UsageThresholds = DEFAULT_USAGE_THRESHOLDS): Exclude<UsageLevel, 'unknown'> {
  const pct = utilization * 100;
  if (pct >= t.overPct) return 'over';
  if (pct >= t.warnPct) return 'warn';
  return 'ok';
}

/** The highest-utilization window present, or undefined when none is. */
export function bindingWindow(w: WindowsObservation | undefined): BindingWindow | undefined {
  if (w === undefined) return undefined;
  let best: BindingWindow | undefined;
  for (const key of WINDOW_KEYS) {
    const win = w[key];
    if (win === undefined) continue;
    if (best !== undefined && win.utilization <= best.utilization) continue;
    best = {
      key,
      label: WINDOW_LABELS[key],
      utilization: win.utilization,
      pct: Math.round(win.utilization * 100),
      ...(win.resetsAt !== undefined ? { resetsAt: win.resetsAt } : {}),
    };
  }
  return best;
}

/** True when the observation is older than {@link USAGE_STALE_AFTER_MS}. */
export function isStale(observedAt: number, now: number): boolean {
  return now - observedAt > USAGE_STALE_AFTER_MS;
}

/**
 * Evaluate a record. A stale or window-less record is `unknown` — a rolling
 * window only drains while idle, so an old reading is never trusted to block
 * or warn. A freeze is reported alongside but does not change the level.
 */
export function evaluateUsage(
  rec: UsageRecord | undefined,
  now: number = Date.now(),
  thresholds: UsageThresholds = DEFAULT_USAGE_THRESHOLDS,
): UsageEvaluation {
  const frozen = rec?.perMinute?.frozenUntil;
  const freeze = frozen !== undefined && frozen > now ? { frozenUntil: frozen } : {};
  const windows = rec?.windows;
  const binding = bindingWindow(windows);
  if (windows === undefined || binding === undefined) {
    return { level: 'unknown', stale: false, ...freeze };
  }
  if (isStale(windows.observedAt, now)) {
    return { level: 'unknown', stale: true, binding, ...freeze };
  }
  return { level: levelFor(binding.utilization, thresholds), stale: false, binding, ...freeze };
}
