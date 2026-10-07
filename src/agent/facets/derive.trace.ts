/**
 * Trace-signal extraction for the facet deriver.
 *
 * Parses the raw text of a `trace.jsonl` file (passed in as a string so
 * this module stays pure / no-I/O) and extracts the two deferred signals
 * from issue #2798:
 *
 *   - `traceClosureReason`: the `ClosureReason` from the terminal `closure`
 *     event. Values `budget_exceeded`, `iteration_cap`, and `truncated` all
 *     indicate the session ended abnormally. Absent when the trace has no
 *     `closure` event or the file could not be read.
 *
 *   - `hasSubagentBudgetExhaustion`: true when at least one
 *     `subagent_lifecycle.succeeded` event carried
 *     `stopReason === 'tool_use_loop_capped'`, meaning a forked subagent
 *     hit its tool-round ceiling before it could finish naturally.
 *     False (not undefined) because absence of the signal is only returned
 *     when the whole `TraceSignals` object is absent.
 *
 * Both callers (store.ts) pass the raw file content; absence of the file,
 * or any read error, is signalled by returning `undefined` from the store
 * helper — never by modifying the signal values here.
 *
 * @module agent/facets/derive.trace
 */

/** The subset of trace `closure` reasons that trigger a downgrade. */
export type DowngradableClosureReason = 'budget_exceeded' | 'iteration_cap' | 'truncated';

/** Signals extracted from a session's witness trace. */
export interface TraceSignals {
  /**
   * The `closure` event's `reason`, narrowed to a downgrade-relevant value.
   * Undefined when the trace has no `closure` event or the reason is not
   * downgrade-relevant (e.g. `model_end_turn`, `abort`, …).
   */
  traceClosureReason: DowngradableClosureReason | undefined;
  /**
   * True when at least one `subagent_lifecycle.succeeded` event carried
   * `stopReason === 'tool_use_loop_capped'` — a subagent hit its tool-round
   * budget and was wound down before it could finish naturally.
   */
  hasSubagentBudgetExhaustion: boolean;
}

/**
 * Parse trace signals from raw `trace.jsonl` content.
 *
 * Deliberately tolerant: blank lines, malformed JSON, and unknown event
 * kinds are all skipped. An absent / empty file returns signals with no
 * closure reason and no subagent exhaustion — callers treat that as "no
 * signal", never as a downgrade.
 */
export function parseTraceSignals(content: string): TraceSignals {
  let traceClosureReason: DowngradableClosureReason | undefined;
  let hasSubagentBudgetExhaustion = false;

  const DOWNGRADE_REASONS = new Set<string>(['budget_exceeded', 'iteration_cap', 'truncated']);

  for (const rawLine of content.split('\n')) {
    if (!rawLine.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawLine);
      if (!parsed || typeof parsed !== 'object') continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const kind = obj['kind'];

    if (kind === 'closure') {
      const payload = obj['payload'];
      if (payload && typeof payload === 'object') {
        const reason = (payload as Record<string, unknown>)['reason'];
        if (typeof reason === 'string' && DOWNGRADE_REASONS.has(reason)) {
          traceClosureReason = reason as DowngradableClosureReason;
        }
      }
      // There is at most one closure event — no need to continue scanning for it,
      // but we must continue to find subagent_lifecycle events.
    }

    if (kind === 'subagent_lifecycle') {
      const payload = obj['payload'];
      if (payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        if (
          p['transition'] === 'succeeded' &&
          p['stopReason'] === 'tool_use_loop_capped'
        ) {
          hasSubagentBudgetExhaustion = true;
        }
      }
    }
  }

  return { traceClosureReason, hasSubagentBudgetExhaustion };
}
