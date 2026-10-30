/**
 * Per-writer hook_decision tally behind the `hook_summary` trace event.
 *
 * Invariant: `hook_decision` rows that carry no information (only
 * `hookEvent`, optionally `subagentId`) are NOT written to the trace — they
 * were ~90% of all hook_decision volume and drowned real blocks in
 * `search_witness`. Every emission, written or suppressed, is counted here
 * instead, so allow-path volume stays measurable via the once-per-session
 * `hook_summary` event that `sealTraceWriter` writes just before the seal.
 *
 * Contract (scoping): the tally is keyed by trace-writer IDENTITY. Forked
 * subagents inherit the parent's writer, so one tally (and one summary)
 * covers the root session INCLUDING all its children; it is not split by
 * subagentId. A sink that wraps another writer (e.g. the daemon's gate-block
 * counting shim) exposes `hookTallyKey` pointing at the wrapped writer so its
 * emissions land in the same tally as the session's own.
 *
 * Invariant (INV-040): tallying is pure in-memory bookkeeping; it never
 * throws into an emit site and never affects dispatch.
 *
 * @module agent/trace/hook-tally
 */

import type { HookDecisionPayload, HookSummaryPayload } from './types.js';
import type { TraceSink } from './writer.js';

/** Optional structural alias: a wrapping sink names the writer it tallies under. */
export interface HookTallyAliasedSink extends TraceSink {
  readonly hookTallyKey: TraceSink;
}

interface Tally {
  counts: Map<string, Map<string, number>>;
  written: number;
  suppressed: number;
}

const tallies = new WeakMap<object, Tally>();
/** Writers that already had their summary taken — guards double-emission. */
const summarized = new WeakSet<object>();

function tallyKey(writer: TraceSink): object {
  const alias = (writer as Partial<HookTallyAliasedSink>).hookTallyKey;
  return alias ?? writer;
}

/**
 * True when a hook_decision payload carries information beyond its
 * `hookEvent` (and attribution `subagentId`): a decision, reason, blocked
 * tool, injected-context size, approval-gate timing, or approval outcome.
 */
export function isInformativeHookDecision(p: HookDecisionPayload): boolean {
  return (
    p.decision !== undefined ||
    p.ruleId !== undefined ||
    (p.reason !== undefined && p.reason.length > 0) ||
    p.blockedTool !== undefined ||
    p.injectedContextBytes !== undefined ||
    p.durationMs !== undefined ||
    p.approvalOutcome !== undefined
  );
}

/** Count one hook_decision emission (written or suppressed). Never throws. */
export function recordHookDecision(
  writer: TraceSink,
  p: HookDecisionPayload,
  written: boolean,
): void {
  try {
    const key = tallyKey(writer);
    let t = tallies.get(key);
    if (t === undefined) {
      t = { counts: new Map(), written: 0, suppressed: 0 };
      tallies.set(key, t);
    }
    let byOutcome = t.counts.get(p.hookEvent);
    if (byOutcome === undefined) {
      byOutcome = new Map();
      t.counts.set(p.hookEvent, byOutcome);
    }
    const outcome = p.decision ?? 'allow';
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
    if (written) t.written++;
    else t.suppressed++;
  } catch {
    /* observability only (INV-040) */
  }
}

/**
 * Take (and clear) the summary for `writer`. Returns `undefined` when a
 * summary was already taken for this writer, so a second seal attempt never
 * double-emits. A writer that saw no hook dispatches yields zero counts: a
 * present summary with empty `counts` means "zero", a MISSING summary means
 * "unknown" (crash, process-exit backstop seal, or a pre-feature trace).
 */
export function takeHookSummary(writer: TraceSink): HookSummaryPayload | undefined {
  const key = tallyKey(writer);
  if (summarized.has(key)) return undefined;
  summarized.add(key);
  const t = tallies.get(key);
  tallies.delete(key);
  const counts: Record<string, Record<string, number>> = {};
  for (const [hookEvent, byOutcome] of t?.counts ?? []) {
    counts[hookEvent] = Object.fromEntries(byOutcome);
  }
  return {
    scope: 'root-session-including-subagents',
    counts,
    written: t?.written ?? 0,
    suppressed: t?.suppressed ?? 0,
  };
}
