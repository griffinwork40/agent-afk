/**
 * Fan-out usage notice (compose / `agent` dispatch start).
 *
 * When the parent runs on Claude, reads the Claude subscription record through
 * the shared reader (`usage/usage-snapshot.ts` — cross-process ledger merged
 * with this process's quota cache), grades it with the shared evaluator
 * (`usage/usage-budget.ts`, warn >= 80%, over >= 100%), and — only at warn or
 * over — returns ONE line for the tool result and emits a `usage_notice`
 * session_phase trace event.
 *
 * Invariant: observer only. No blocking, no routing change, no model
 * downgrade, and nothing is injected into the system prompt. A stale or absent
 * reading is `unknown` and produces nothing.
 *
 * @module agent/tools/usage-notice
 */

import { emitSessionPhase } from '../trace/emit.js';
import type { TraceSink } from '../trace/index.js';
import { providerForModel } from '../providers/index.js';
import type { UsageRecord } from '../usage/usage-record.js';
import { readUsageRecord, ANTHROPIC_OAUTH } from '../usage/usage-snapshot.js';
import { evaluateUsage, type UsageEvaluation } from '../usage/usage-budget.js';
import { describeBindingWindow } from '../usage/usage-formatter.js';

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
 */
export async function evaluateDispatchUsage(
  provider: string,
  traceWriter: TraceSink | undefined,
  readRecord: () => UsageRecord | undefined = () => readUsageRecord(ANTHROPIC_OAUTH.provider, ANTHROPIC_OAUTH.account),
): Promise<string | undefined> {
  // Only Claude sessions draw down the subscription windows we track.
  if (provider !== 'anthropic-direct') return undefined;
  const now = Date.now();
  const ev = evaluateUsage(readRecord(), now);
  const notice = buildUsageNotice(ev, now);
  if (notice === undefined || ev.binding === undefined) return undefined;
  void emitSessionPhase(traceWriter, {
    phase: 'usage_notice',
    metadata: {
      level: ev.level,
      pct: ev.binding.pct,
      windowLabel: ev.binding.label,
      ...(ev.binding.resetsAt !== undefined ? { resetsAtMs: ev.binding.resetsAt } : {}),
    },
  });
  return notice;
}

/**
 * Convenience wrapper: resolve `model` → provider via `providerForModel`, then
 * delegate to {@link evaluateDispatchUsage}. Accepts any value; non-strings are
 * treated as "no model hint" so callers can pass ctx fields without a type guard.
 *
 * Replaces the 4-line `parentProvider` + `evaluateDispatchUsage` pattern in
 * executor callsites with a single 1-line call, keeping those functions under
 * the size ceiling.
 */
export function evaluateDispatchUsageForModel(model: unknown, traceWriter: TraceSink | undefined): Promise<string | undefined> {
  return evaluateDispatchUsage(providerForModel(typeof model === 'string' ? model : undefined), traceWriter);
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
