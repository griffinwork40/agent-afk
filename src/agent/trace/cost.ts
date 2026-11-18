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
 * Contract: root/subagent split (#4896). A REPL session that runs `/clear`
 * writes one root closure per cycle, so `rootCostUsd` and `rootTurnCount` sum
 * every closure that belongs to the root. Whether an unstamped closure (no
 * `subagentId`) belongs to the root depends on the trace:
 *   1. Some closure carries `subagentId` (stamped since #3932, 2026-10-16):
 *      unstamped closures are root closures.
 *   2. The trace shows no subagent activity at all (no `subagent_lifecycle`
 *      or `background_agent` event, no stamped closure, and a seal with no
 *      subagent rollup): every closure is a root closure. Every fork emits
 *      `subagent_lifecycle` `started` into the shared trace before it can
 *      close (`subagent/fork-lifecycle.ts`, since #466), so a child closure
 *      never appears without one.
 *   3. Otherwise (subagent activity, no stamped closure: a pre-#3932 trace,
 *      or one whose children never closed) the closures cannot be told
 *      apart. `rootCostUsd` and `rootTurnCount` keep the seal's last-cycle
 *      figures, as before #4896.
 * In cases 1 and 2 a root closure lost to a failed write adds the seal's root
 * figures, matching `total`. The root writes its final closure and the seal
 * from one accounting snapshot, so its final closure carries the seal's cost
 * AND turn count. The closure is lost when the last unstamped closure does not
 * match the seal on both (#4912 item 2): a child that closes after the root's
 * final closure (the Ctrl+B detach teardown is not awaited by shutdown) must
 * not make the root look lost. Matching on turns as well as cost keeps two
 * root cycles of equal cost apart unless their turn counts also agree; the
 * trace carries no cycle id, so that remaining tie reads as "not lost".
 *
 * Crash (`session_sealed.incomplete`, the process-exit backstop): the last
 * root cycle never closed, so its spend is not in the trace at all. In cases
 * 1 and 2 the root closures that did land (earlier `/clear` cycles) are still
 * root spend, so `rootCostUsd` and `rootTurnCount` sum them; with no root
 * closure, or in case 3, the root is unknown and both stay absent (#4912 item 1).
 *
 * No seal (unsealed trace): case 3 reports the last closure's cost and turn
 * count as the root's, so a reader never sees one without the other (#4912
 * item 4).
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
  /** Root actor's cost over every REPL cycle (see the split contract above). Absent when `source` is `none`; for `closures-incomplete`, the closed root cycles only, absent when none closed or provenance is ambiguous. */
  rootCostUsd?: number;
  /** `totalCostUsd - rootCostUsd`, floored at 0. Absent when `source` is `none`. */
  subagentCostUsd?: number;
  /** Whole-trace spend: root plus every subagent at every depth. */
  totalCostUsd?: number;
  /** Root turns over every REPL cycle (case 3: the seal's, or with no seal the last closure's). Absent when no record carries it or the root is unknown. */
  rootTurnCount?: number;
  /** Tokens summed over every closure event (same scope as `totalCostUsd`). */
  totalTokens?: CostTokens;
  /** Number of `closure` events seen. */
  closureCount: number;
  source: SessionCostSource;
  /**
   * Whole-trace subscription-overage cost (#4883): sum of `closure.overageCostUsd`
   * over the same closures as `totalCostUsd`, clamped to `totalCostUsd`. Present
   * (possibly 0) only when at least one closure carried the field.
   */
  overageCostUsd?: number;
  /** Sum of `closure.overageRequests`; same presence rule as `overageCostUsd`. */
  overageRequests?: number;
  /**
   * `true` when the overage pair is present but the closure set did not account
   * for the whole of `totalCostUsd` (see {@link overageIsIncomplete}), so both
   * overage figures are lower bounds. Never `false`: absence means complete.
   */
  overageIncomplete?: true;
}

/**
 * Slack for comparing the closure sum with a total built from seal figures:
 * the seal sums the same per-session costs in a different order, so an exact
 * comparison could flag float rounding as missing spend.
 */
const OVERAGE_TOTAL_EPSILON_USD = 1e-9;

/**
 * Whether the overage figures summed from closures are partial (#4883). True
 * when the root closure is known missing (`closures-incomplete`), or when
 * `totalCostUsd` exceeds the closure sum because seal figures filled in spend
 * no closure reported (a lost root closure, or a child whose closure was never
 * written but whose cost reached `seal.subagentCostUsd`).
 */
function overageIsIncomplete(r: SessionCostBreakdown, closureSum: number): boolean {
  if (r.source === 'closures-incomplete') return true;
  return (r.totalCostUsd ?? 0) - closureSum > OVERAGE_TOTAL_EPSILON_USD;
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
  private lastClosureTurns: number | undefined;
  /** Cost and turns of the last unstamped closure: the root's final closure when it was written. */
  private lastRootClosure: { cost: number; turns: number | undefined } | undefined;
  /** `subagentId` from the last closure event; `null` = root (field absent); `undefined` = no closure yet. */
  private lastClosureSubagentId: string | null | undefined = undefined;
  /** Sum of cost across all root-cycle closures (no `subagentId`). Used for the root/subagent split on multi-cycle traces (#4896). */
  private rootCycleSum = 0;
  /** Sum of `finalTurnCount` across all root-cycle closures. */
  private rootCycleTurnCount = 0;
  /** Whether any child closure (with `subagentId`) was seen (split case 1). */
  private hasChildClosure = false;
  /** Whether any event shows subagent activity; false means split case 2. */
  private sawSubagentActivity = false;
  private readonly tokens: Record<(typeof TOKEN_KEYS)[number], number> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
  };
  private sealRoot: number | undefined;
  private sealSubagent = 0;
  private sealTurns: number | undefined;
  private sealIncomplete = false;
  /** #4883 overage totals; undefined until a closure carries the fields. */
  private overage: { costUsd: number; requests: number } | undefined;

  add(event: CostEventLike): void {
    if (event.kind === 'subagent_lifecycle' || event.kind === 'background_agent') {
      this.sawSubagentActivity = true;
      return;
    }
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
      const turns = finiteNonNeg(p['finalTurnCount']);
      this.lastClosureTurns = turns;
      // Track provenance: string = child actor, null = root (field absent).
      const subagentId = typeof p['subagentId'] === 'string' ? p['subagentId'] : null;
      this.lastClosureSubagentId = subagentId;
      if (subagentId === null) {
        // Root closure: accumulate for the multi-cycle root/subagent split.
        this.rootCycleSum += cost;
        if (turns !== undefined) this.rootCycleTurnCount += turns;
        this.lastRootClosure = { cost, turns };
      } else {
        this.hasChildClosure = true;
        this.sawSubagentActivity = true;
      }
      this.addOverage(p);
      const t = asRecord(p['finalTokens']);
      if (t !== undefined) {
        for (const k of TOKEN_KEYS) this.tokens[k] += finiteNonNeg(t[k]) ?? 0;
      }
    } else if (event.kind === 'session_sealed') {
      this.sealRoot = finiteNonNeg(p['finalCostUsd']) ?? 0;
      this.sealSubagent = finiteNonNeg(p['subagentCostUsd']) ?? 0;
      this.sealTurns = finiteNonNeg(p['finalTurnCount']);
      if (this.sealSubagent > 0 || (finiteNonNeg(p['subagentCount']) ?? 0) > 0) this.sawSubagentActivity = true;
      // sealOnProcessExit() writes incomplete:true with finalCostUsd:0 as a
      // backstop; treat it as a marker only — do not use its $0 as rootCostUsd.
      this.sealIncomplete = p['incomplete'] === true;
    }
  }

  /** Fold one valid closure's overage fields; both must be present and valid. */
  private addOverage(p: Record<string, unknown>): void {
    const cost = finiteNonNeg(p['overageCostUsd']);
    const requests = finiteNonNeg(p['overageRequests']);
    // Parsed traces bypass the write-time schema: reject a corrupt pair rather
    // than invent a rounded request count or sum fractional requests.
    if (cost === undefined || requests === undefined || !Number.isInteger(requests)) return;
    const prev = this.overage ?? { costUsd: 0, requests: 0 };
    this.overage = { costUsd: prev.costUsd + cost, requests: prev.requests + requests };
  }

  result(): SessionCostBreakdown {
    const r = this.baseResult();
    if (this.overage === undefined) return r;
    const cap = r.totalCostUsd ?? 0;
    // A clamp that actually reduces the figure means the accounting disagreed:
    // the request count no longer matches the dollars, so flag it as well.
    const clamped = this.overage.costUsd > cap;
    const incomplete = clamped || overageIsIncomplete(r, this.closureSum);
    return {
      ...r,
      overageCostUsd: Math.min(this.overage.costUsd, cap),
      overageRequests: this.overage.requests,
      ...(incomplete ? { overageIncomplete: true as const } : {}),
    };
  }

  private baseResult(): SessionCostBreakdown {
    const hasClosures = this.closureCount > 0;
    const hasSeal = this.sealRoot !== undefined;
    if (!hasClosures && !hasSeal) return { closureCount: 0, source: 'none' };
    const tokens = this.tokenTotals();

    // #3890 item 2: sealOnProcessExit() writes a backstop seal (incomplete:true,
    // finalCostUsd:0) and the root's last-cycle closure is never written; never
    // use the backstop's $0 as root spend. Root closures from earlier `/clear`
    // cycles do survive, and in split cases 1 and 2 they are the root's
    // (#4912 item 1). Otherwise the root is UNKNOWN: leave it absent rather
    // than promote a child's closure to root.
    if (this.sealIncomplete) {
      const rootKnown = this.lastRootClosure !== undefined && this.provenanceKnown();
      const rootCostUsd = rootKnown ? this.rootCycleSum : undefined;
      return {
        ...(rootKnown ? { rootCostUsd, rootTurnCount: this.rootCycleTurnCount } : {}),
        subagentCostUsd: Math.max(0, this.closureSum - (rootCostUsd ?? 0)),
        totalCostUsd: this.closureSum,
        ...tokens,
        closureCount: this.closureCount,
        source: 'closures-incomplete',
      };
    }

    const sealTotal = (this.sealRoot ?? 0) + this.sealSubagent;
    let totalCostUsd: number;
    let rootClosureLost = false;
    if (!hasClosures) {
      totalCostUsd = sealTotal;
    } else if (!hasSeal) {
      totalCostUsd = this.closureSum;
    } else {
      // #3890 item 1: when the last closure's cost differs from sealRoot, the
      // root closure write failed but the seal succeeded, so add sealRoot to
      // closureSum. Either way the seal's own total stays a lower bound.
      //
      // #3932: prefer actor provenance. When the last closure is a child, the
      // root's final closure is the last UNSTAMPED one, if it was written; it
      // matches the seal on cost and turns (#4912 item 2: a child that closes
      // after the root must not count the last cycle twice). Older traces
      // without the field keep the cost-equality check on the last closure.
      rootClosureLost =
        this.lastClosureSubagentId !== null && this.lastClosureSubagentId !== undefined
          ? !this.lastRootClosureMatchesSeal()
          : this.lastClosureCost !== this.sealRoot; // legacy equality heuristic
      const closureBased = rootClosureLost ? this.closureSum + (this.sealRoot ?? 0) : this.closureSum;
      totalCostUsd = Math.max(closureBased, sealTotal);
    }

    const root = this.rootSplit(hasClosures, rootClosureLost);
    const rootCostUsd = root.cost;
    const subagentCostUsd = Math.max(0, totalCostUsd - rootCostUsd);
    return {
      rootCostUsd,
      subagentCostUsd,
      totalCostUsd,
      ...(root.turns !== undefined ? { rootTurnCount: root.turns } : {}),
      ...tokens,
      closureCount: this.closureCount,
      source: hasClosures ? (hasSeal ? 'closures+seal' : 'closures') : 'seal',
    };
  }

  /** Root cost and turns per the split contract in the module comment. */
  private rootSplit(hasClosures: boolean, rootClosureLost: boolean): { cost: number; turns?: number } {
    if (!hasClosures) return { cost: this.sealRoot ?? 0, ...(this.sealTurns !== undefined ? { turns: this.sealTurns } : {}) };
    if (this.provenanceKnown()) {
      // Cases 1 and 2: every unstamped closure is a root cycle.
      if (!rootClosureLost) return { cost: this.rootCycleSum, turns: this.rootCycleTurnCount };
      return { cost: this.rootCycleSum + (this.sealRoot ?? 0), turns: this.rootCycleTurnCount + (this.sealTurns ?? 0) };
    }
    // Case 3: ambiguous provenance; keep the seal's last-cycle root figures,
    // or with no seal the last closure's cost AND turns (#4912 item 4).
    const hasSeal = this.sealRoot !== undefined;
    const turns = hasSeal ? this.sealTurns : this.lastClosureTurns;
    return { cost: this.sealRoot ?? this.lastClosureCost ?? 0, ...(turns !== undefined ? { turns } : {}) };
  }

  /** Split cases 1 and 2: every unstamped closure is a root cycle. */
  private provenanceKnown(): boolean {
    return this.hasChildClosure || !this.sawSubagentActivity;
  }

  /** Whether the last unstamped closure carries the seal's root cost and (when both are known) turn count. */
  private lastRootClosureMatchesSeal(): boolean {
    const last = this.lastRootClosure;
    if (last === undefined || last.cost !== this.sealRoot) return false;
    return last.turns === undefined || this.sealTurns === undefined || last.turns === this.sealTurns;
  }

  private tokenTotals(): { totalTokens?: CostTokens } {
    const totalTokens: CostTokens = {};
    for (const k of TOKEN_KEYS) if (this.tokens[k] > 0) totalTokens[k] = this.tokens[k];
    return Object.keys(totalTokens).length > 0 ? { totalTokens } : {};
  }
}

/**
 * Receipt `cost` whole-session fields: `totalCostUsd` when known, plus the
 * overage pair (#4883), both or neither per the presence rule, and
 * `overageIncomplete` only alongside the pair.
 */
export function totalCostFields(
  sc: SessionCostBreakdown,
): { totalCostUsd?: number; overageCostUsd?: number; overageRequests?: number; overageIncomplete?: true } {
  const total = sc.totalCostUsd !== undefined ? { totalCostUsd: sc.totalCostUsd } : {};
  if (sc.overageCostUsd === undefined || sc.overageRequests === undefined) return total;
  return {
    ...total,
    overageCostUsd: sc.overageCostUsd,
    overageRequests: sc.overageRequests,
    ...(sc.overageIncomplete === true ? { overageIncomplete: true as const } : {}),
  };
}

/** Compute the cost breakdown of one trace from its events. Pure. */
export function computeSessionCost(events: Iterable<CostEventLike>): SessionCostBreakdown {
  const acc = new SessionCostAccumulator();
  for (const ev of events) acc.add(ev);
  return acc.result();
}
