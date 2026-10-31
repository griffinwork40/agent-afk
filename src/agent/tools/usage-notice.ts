/**
 * Fan-out usage notice and dispatch gate (compose / `agent` dispatch start).
 *
 * When the parent runs on Claude, reads the Claude subscription record through
 * the shared reader (`usage/usage-snapshot.ts` — cross-process ledger merged
 * with this process's quota cache), grades it with the shared evaluator
 * (`usage/usage-budget.ts`, warn >= 80%, over >= 100%), and — at warn or
 * over — returns ONE line for the tool result and emits a `usage_notice`
 * session_phase trace event.
 *
 * Contract: at `warn` the notice is advisory only — no blocking, no routing
 * change, no model downgrade. At `over` (>= 100%) the `blocked` flag is set
 * so callers can refuse dispatch instead of spawning children that immediately
 * fail with UsageLimitError. A stale or absent reading is `unknown` and
 * produces `{ notice: undefined, blocked: false }`.
 *
 * @module agent/tools/usage-notice
 */

import { emitSessionPhase } from '../trace/emit.js';
import { isUsageAwarenessEnabled } from '../usage/usage-awareness-toggle.js';
import type { TraceSink } from '../trace/index.js';
import { providerForModel } from '../providers/index.js';
import type { UsageRecord } from '../usage/usage-record.js';
import { readUsageRecord, ANTHROPIC_OAUTH } from '../usage/usage-snapshot.js';
import { evaluateUsage, type UsageEvaluation } from '../usage/usage-budget.js';
import { describeBindingWindow } from '../usage/usage-formatter.js';

/** Structured result from a fan-out usage evaluation. */
export interface DispatchUsageResult {
  /** One-line notice for a warn/over evaluation; `undefined` for ok/unknown. */
  readonly notice: string | undefined;
  /** True when usage is at or above the `over` threshold (>= 100%). */
  readonly blocked: boolean;
}

/** One-line notice for a warn/over evaluation; `undefined` otherwise. */
export function buildUsageNotice(ev: UsageEvaluation, now: number = Date.now()): string | undefined {
  if ((ev.level !== 'warn' && ev.level !== 'over') || ev.binding === undefined) return undefined;
  return `Usage notice: ${describeBindingWindow(ANTHROPIC_OAUTH.provider, ev.binding, now)}`;
}

/**
 * Evaluate usage for the parent's provider; on warn/over emit a `usage_notice`
 * trace event (fire-and-forget) and return the notice line. Returns
 * `undefined` for ok / unknown / non-Claude parents.
 *
 * @param provider     The parent session's resolved provider (`providerForModel`).
 * @param traceWriter  Optional trace sink; when absent, no event is emitted.
 * @param readRecord   Injectable for tests; defaults to the shared reader.
 * @param model        Optional dispatched child model; used to skip irrelevant
 *                     model-scoped windows (e.g. sevenDayOpus for Sonnet). (#4475)
 */
export async function evaluateDispatchUsage(
  provider: string,
  traceWriter: TraceSink | undefined,
  readRecord: () => UsageRecord | undefined = () => readUsageRecord(ANTHROPIC_OAUTH.provider, ANTHROPIC_OAUTH.account),
  model?: string,
): Promise<DispatchUsageResult> {
  const none: DispatchUsageResult = { notice: undefined, blocked: false };
  // Only Claude sessions draw down the subscription windows we track.
  if (provider !== 'anthropic-direct') return none;
  if (!isUsageAwarenessEnabled()) return none;
  const now = Date.now();
  const ev = evaluateUsage(readRecord(), now, undefined, model);
  const notice = buildUsageNotice(ev, now);
  if (notice === undefined || ev.binding === undefined) return none;
  void emitSessionPhase(traceWriter, {
    phase: 'usage_notice',
    metadata: {
      level: ev.level,
      pct: ev.binding.pct,
      windowLabel: ev.binding.label,
      ...(ev.binding.resetsAt !== undefined ? { resetsAtMs: ev.binding.resetsAt } : {}),
    },
  });
  return { notice, blocked: ev.level === 'over' };
}

/**
 * Convenience wrapper: resolve `model` → provider via `providerForModel`, then
 * delegate to {@link evaluateDispatchUsage}. Accepts any value; non-strings are
 * treated as "no model hint" so callers can pass ctx fields without a type guard.
 *
 * Replaces the 4-line `parentProvider` + `evaluateDispatchUsage` pattern in
 * executor callsites with a single 1-line call, keeping those functions under
 * the size ceiling.
 *
 * Passes the model string through to {@link evaluateDispatchUsage} so
 * model-scoped windows are filtered correctly for the child being dispatched. (#4475)
 */
export function evaluateDispatchUsageForModel(model: unknown, traceWriter: TraceSink | undefined): Promise<DispatchUsageResult> {
  const modelStr = typeof model === 'string' ? model : undefined;
  return evaluateDispatchUsage(providerForModel(modelStr), traceWriter, undefined, modelStr);
}

/**
 * Prepend the usage notice line to a string result, if a notice is present.
 * Returns the original value unchanged when `notice` is `undefined` or when
 * `content` is not a string (so callers with `string | ToolContent[]` fields
 * can pass the field directly without a prior type guard).
 *
 * Keeps the conditional-prepend at each callsite to one line.
 */
export function prependUsageNotice(notice: string | undefined, content: string): string;
export function prependUsageNotice(notice: string | undefined, content: unknown): unknown;
export function prependUsageNotice(notice: string | undefined, content: unknown): unknown {
  return notice !== undefined && typeof content === 'string' ? `${notice}\n${content}` : content;
}
