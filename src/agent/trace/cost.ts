/**
 * The one definition of a witness trace's session cost (#3879).
 *
 * Receipts, facets, and `afk insights` all read cost through this module so
 * they report the same number for the same trace.
 *
 * Invariant: a `trace.jsonl` holds one `closure` event per `AgentSession`
 * lifecycle cycle: the root's (one per REPL cycle; `/clear` re-zeroes its
 * accumulator) and one per forked subagent at every depth, because children
 * share the root's `TraceWriter`. Each instance owns a DISJOINT cost
 * accumulator (see `improve/scan/detectors/closure-anomaly.ts`), so the sum of
 * `closure.finalCostUsd` over the whole file is the trace's total spend.
 *
 * Invariant: `session_sealed.finalCostUsd` is the root's LAST cycle only, and
 * `session_sealed.subagentCostUsd` grows only on the success path
 * (`subagent/handle.run-success.ts`), so failed, cancelled, and nested
 * children never reach it. Both seal figures are therefore lower bounds. On
 * 2,671 traces measured on 2026-10-16 the closure sum was never below
 * seal root + seal subagent; it exceeded it on 691 traces ($1.6k over 30 days).
 * `total` takes the larger of the two lower bounds so a trace whose root
 * closure was lost (crash before closure, seal written) is not under-reported.
 *
 * Root/subagent split (#4896): closure events carry an optional `subagentId`
 * field (stamped since #3932). Root closures lack the field; child closures
 * carry it as a string. `rootCostUsd` sums every root closure so multi-cycle
 * REPL traces (each `/clear` emits one root closure) are attributed correctly.
 * `rootTurnCount` sums `finalTurnCount` across the same root closures.
 * Compatibility: older traces where child closures also lack `subagentId`
 * (pre-#3932) are handled by the existing equality heuristic in `result()` for
 * total computation; the root-cycle sum is best-effort on those traces.
 *
 * @module agent/trace/cost
 */

/** Which trace records the breakdown was computed from. */
export type SessionCostSource = 'closures+seal' | 'closures' | 'closures-incomplete' | 'seal' | 'none';

/** Token counters summed across closure events. */
export interface CostTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** Cost of one witness trace, split into root and subagent spend. */
export interface SessionCostBreakdown {
  /** Root actor's cost (its last lifecycle cycle). Absent when `source` is `none`. */
  rootCostUsd?: number;
  /** `totalCostUsd - rootCostUsd`, floored at 0. Absent when `source` is `none`. */
  subagentCostUsd?: number;
  /** Whole-trace spend: root plus every subagent at every depth. */
  totalCostUsd?: number;
  /** Tokens summed over every closure event (same scope as `totalCostUsd`). */
  totalTokens?: CostTokens;
  /** Number of `closure` events seen. */
  closureCount: number;
  source: SessionCostSource;
}

/** Structural event shape: accepts typed `TraceEvent`s and raw parsed JSON. */
export interface CostEventLike {
  kind: unknown;
  payload?: unknown;
}

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;

function finiteNonNeg(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

/** Incremental form, for callers that already iterate a trace's events. */
export class SessionCostAccumulator {
  private closureSum = 0;
  private closureCount = 0;
  private lastClosureCost: number | undefined;
  /** `subagentId` from the last closure event; `null` = root (field absent); `undefined` = no closure yet. */
  private lastClosureSubagentId: string | null | undefined = undefined;
  /** Sum of cost across all root-cycle closures (no `subagentId`). Used for the root/subagent split on multi-cycle traces (#4896). */
  private rootCycleSum = 0;
  /** Sum of `finalTurnCount` across all root-cycle closures. */
  private rootCycleTurnCount = 0;
  /** Whether any child closure (with `subagentId`) was seen. When true the trace is new enough to trust the root-cycle sum for the split. */
  private hasChildClosure = false;
  private readonly tokens: Record<(typeof TOKEN_KEYS)[number], number> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
  };
  private sealRoot: number | undefined;
  private sealSubagent = 0;
  private sealIncomplete = false;

  add(event: CostEventLike): void {
    const p = asRecord(event.payload);
    if (p === undefined) return;
    if (event.kind === 'closure') {
      // Item 3: skip closures whose cost is invalid (NaN/negative/missing);
      // closureCount means valid closures only.
      const cost = finiteNonNeg(p['finalCostUsd']);
      if (cost === undefined) return;
      this.closureCount++;
      this.closureSum += cost;
      this.lastClosureCost = cost;
      // Track provenance: string = child actor, null = root (field absent).
      const subagentId = typeof p['subagentId'] === 'string' ? p['subagentId'] : null;
      this.lastClosureSubagentId = subagentId;
      if (subagentId === null) {
        // Root closure: accumulate for the multi-cycle root/subagent split.
        this.rootCycleSum += cost;
        const turns = finiteNonNeg(p['finalTurnCount']);
        if (turns !== undefined) this.rootCycleTurnCount += turns;
      } else {
        this.hasChildClosure = true;
      }
      const t = asRecord(p['finalTokens']);
      if (t !== undefined) {
        for (const k of TOKEN_KEYS) this.tokens[k] += finiteNonNeg(t[k]) ?? 0;
      }
    } else if (event.kind === 'session_sealed') {
      this.sealRoot = finiteNonNeg(p['finalCostUsd']) ?? 0;
      this.sealSubagent = finiteNonNeg(p['subagentCostUsd']) ?? 0;
      // sealOnProcessExit() writes incomplete:true with finalCostUsd:0 as a
      // backstop; treat it as a marker only — do not use its $0 as rootCostUsd.
      this.sealIncomplete = p['incomplete'] === true;
    }
  }

  /**
   * Sum of `finalTurnCount` across all root-cycle closures. Used by the receipt
   * to report a correct total turn count for multi-cycle REPL sessions (#4896).
   * Zero when no root closure was seen.
   */
  get rootTurnCount(): number {
    return this.rootCycleTurnCount;
  }

  result(): SessionCostBreakdown {
    const hasClosures = this.closureCount > 0;
    const hasSeal = this.sealRoot !== undefined;
    if (!hasClosures && !hasSeal) return { closureCount: 0, source: 'none' };
    const tokens = this.tokenTotals();

    // #3890 item 2: sealOnProcessExit() writes a backstop seal (incomplete:true,
    // finalCostUsd:0) and the root closure is never written, so every surviving
    // closure is a child. The root's spend is UNKNOWN: leave rootCostUsd absent
    // rather than report $0 or promote a child's closure to root.
    if (this.sealIncomplete) {
      return {
        subagentCostUsd: this.closureSum,
        totalCostUsd: this.closureSum,
        ...tokens,
        closureCount: this.closureCount,
        source: 'closures-incomplete',
      };
    }

    const sealTotal = (this.sealRoot ?? 0) + this.sealSubagent;
    let totalCostUsd: number;
    if (!hasClosures) {
      totalCostUsd = sealTotal;
    } else if (!hasSeal) {
      totalCostUsd = this.closureSum;
    } else {
      // #3890 item 1: when the last closure's cost differs from sealRoot, the
      // root closure write failed but the seal succeeded, so add sealRoot to
      // closureSum. Either way the seal's own total stays a lower bound.
      //
      // #3932: prefer actor provenance over cost equality. If the last closure
      // carries a `subagentId` it is a child actor, not the root, so the root
      // closure is lost. Fall back to equality for older traces that lack the
      // field (lastClosureSubagentId === null means root; undefined = no closure).
      const rootClosureLost =
        this.lastClosureSubagentId !== null && this.lastClosureSubagentId !== undefined
          ? true // last closure was a child — root's closure never wrote
          : this.lastClosureCost !== this.sealRoot; // legacy equality heuristic
      const closureBased = rootClosureLost ? this.closureSum + (this.sealRoot ?? 0) : this.closureSum;
      totalCostUsd = Math.max(closureBased, sealTotal);
    }

    // Contract: rootCostUsd sums every root-cycle closure (no subagentId) when
    // hasChildClosure is true — meaning at least one closure carried subagentId
    // (post-#3932 trace). Root closures are unambiguously identified by the
    // absent field, so rootCycleSum is the correct root total and covers every
    // REPL cycle including pre-clear cycles.
    //
    // Compatibility for older traces (pre-#3932) where child closures also
    // lack subagentId: hasChildClosure=false, so we fall back to sealRoot
    // (last cycle only) as before. totalCostUsd is unaffected either way.
    const rootCostUsd = this.hasChildClosure && this.rootCycleSum > 0
      ? this.rootCycleSum
      : (this.sealRoot ?? this.lastClosureCost ?? 0);
    const subagentCostUsd = Math.max(0, totalCostUsd - rootCostUsd);
    return {
      rootCostUsd,
      subagentCostUsd,
      totalCostUsd,
      ...tokens,
      closureCount: this.closureCount,
      source: hasClosures ? (hasSeal ? 'closures+seal' : 'closures') : 'seal',
    };
  }

  private tokenTotals(): { totalTokens?: CostTokens } {
    const totalTokens: CostTokens = {};
    for (const k of TOKEN_KEYS) if (this.tokens[k] > 0) totalTokens[k] = this.tokens[k];
    return Object.keys(totalTokens).length > 0 ? { totalTokens } : {};
  }
}

/** Compute the cost breakdown of one trace from its events. Pure. */
export function computeSessionCost(events: Iterable<CostEventLike>): SessionCostBreakdown {
  const acc = new SessionCostAccumulator();
  for (const ev of events) acc.add(ev);
  return acc.result();
}
