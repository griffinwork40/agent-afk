/**
 * Live child-activity selection for the progress banner's detail slot.
 *
 * Why this exists: while the parent turn is blocked awaiting a foreground
 * subagent (`foreground-promotion.ts` awaits `handle.runToResult`), the
 * orchestrator emits no `progress` event, and `commitThinkingPhase` has already
 * drained `ctx.thinkingLane` — so `deriveProgressActivity` returns `undefined`
 * and the banner's detail line goes blank for the entire child run. The only
 * remaining on-screen motion is decorative (spinner glyph, elapsed counter,
 * random verb, rotating tip), which is why a working agent reads as a hung one.
 *
 * This module fills that slot from state the renderer ALREADY tracks —
 * `SourceState.lastEventAt`, `stats.toolUses`, and `lastProgressSummary` — so
 * it introduces no new event plumbing and, critically, no new timer. The banner
 * repaints on the discrete child transitions that already call
 * `setComposedOverlay`, preserving the "at most one setComposedOverlay call per
 * event" invariant in stream-renderer-orchestrator.ts.
 *
 * Deliberately complementary to the tool lane rather than duplicative: the lane
 * already shows each child's current tool and thinking tail, so this slot
 * reports WHO is active plus round/volume progress and — the part no other
 * surface makes prominent — whether the selected child has gone quiet.
 *
 * @module cli/_lib/child-activity-select
 */

import { formatToolCallStat } from '../format-utils.js';
import { ORCHESTRATOR_SOURCE_KEY, type SourceState } from './stream-renderer-source.js';
import type { ProgressEvent } from '../../agent/types.js';

/**
 * How long a selected child may stay quiet before the tracker is allowed to
 * switch to a livelier sibling.
 *
 * Invariant: this must exceed the 1500ms per-parent overlay throttle in
 * stream-renderer-subagent.ts. Without the hold, N chatty children swap the
 * detail line on every repaint — motion that is technically work-derived but
 * unreadable, which is the failure mode this whole change exists to avoid.
 */
export const STICKY_HOLD_MS = 3000;

/**
 * Silence past which the banner names the child as producing no output.
 *
 * Deliberately decoupled from `PAUSE_THRESHOLD_MS` in stream-renderer-lifecycle.ts
 * (which stays at 30s): the banner reports "no output (waiting)" earlier so the
 * operator sees a quiet child during the 8s–30s dead zone that the tool-lane's
 * `· waiting Xs` annotation (armed only past 30s) does not cover. The static
 * clause avoids a live-ticking counter that would change the *clause* on every
 * recompose; note the composed banner still carries the child's elapsed
 * `durationMs` rounded to whole seconds, so the full overlay string is not
 * byte-stable across a second boundary and setOverlay's identical-string dedup
 * cannot be relied on to absorb repeat flushes. `checkProgressBannerStaleness`
 * (stream-renderer-dead-zone.ts) therefore latches per source and flushes once
 * per quiet transition, riding the existing 80ms pause tick rather than adding
 * a timer (see live-progress-no-timer.test.ts).
 *
 * Invariant: must exceed `STICKY_HOLD_MS` (3s) so the sticky selector has settled
 * before the silence clause appears, and must exceed the 1500ms per-parent
 * overlay throttle in stream-renderer-subagent.ts.
 */
export const CHILD_QUIET_MS = 8_000;

/** A running child worth naming in the banner detail slot. */
export interface ChildActivity {
  /** Source key (the subagent id). */
  sourceId: string;
  /** Human label — `agentType` when known, else the raw source key. */
  label: string;
  /** Progress clause, e.g. `round 3: Read tool-lane.ts` or `no output (waiting)`. */
  clause: string;
  /** True when this child has been silent longer than {@link CHILD_QUIET_MS}. */
  quiet: boolean;
}

/** A child still in flight, paired with how long it has been silent. */
interface Candidate {
  sourceId: string;
  source: SourceState;
  silentMs: number;
}

function runningChildren(
  sources: ReadonlyMap<string, SourceState>,
  now: number,
): Candidate[] {
  const out: Candidate[] = [];
  for (const [sourceId, source] of sources) {
    if (sourceId === ORCHESTRATOR_SOURCE_KEY) continue;
    if (source.done || source.errored) continue;
    out.push({ sourceId, source, silentMs: Math.max(0, now - source.lastEventAt) });
  }
  return out;
}

/**
 * Compose the clause for one child. Priority is most-specific-first: an
 * explicit silence warning beats a stale round headline, which beats a bare
 * call count. Returns `undefined` when the child has produced nothing worth
 * reporting yet, so the caller can fall through rather than render a hollow
 * line like `sees ·` with no content after it.
 */
function clauseFor(candidate: Candidate): string | undefined {
  if (candidate.silentMs >= CHILD_QUIET_MS) {
    // Static clause: intentionally NOT a live-ticking "no output for Xs" counter.
    // A live counter would change the composed string on every recompose,
    // breaking setOverlay's identical-string dedup (terminal-compositor.ts:794)
    // and re-introducing the ghost-row/flicker class the 1500ms H2 throttle
    // (stream-renderer-subagent.ts) exists to prevent. The tool-lane's
    // `· waiting Xs` annotation already shows elapsed silence past 30s
    // (PAUSE_THRESHOLD_MS); the banner just needs to signal the child went
    // quiet, which one static string does.
    return 'no output (waiting)';
  }
  const summary = candidate.source.lastProgressSummary;
  if (summary) return summary;
  const calls = candidate.source.stats.toolUses;
  if (calls > 0) return formatToolCallStat(calls);
  return undefined;
}

/**
 * Stateful selector for "which child should the banner name right now".
 *
 * Holds one field — the previously-selected source key — so the choice is
 * stable across repaints. Owned by StreamRenderer (one instance per turn) and
 * handed to the orchestrator ctx; `setComposedOverlay` rebuilds its ctx object
 * on every call, so the sticky state cannot live there.
 */
export class ChildActivityTracker {
  private prev: string | undefined;

  /**
   * Pick the child to name, or `undefined` when none is worth naming.
   *
   * Selection: newest `lastEventAt` wins, except that an already-selected child
   * is held until it finishes or goes quiet for {@link STICKY_HOLD_MS} AND a
   * livelier sibling exists. When every child is quiet the incumbent is kept —
   * switching between equally-silent children is churn with no information.
   */
  select(
    sources: ReadonlyMap<string, SourceState>,
    now: number = Date.now(),
  ): ChildActivity | undefined {
    const candidates = runningChildren(sources, now);
    if (candidates.length === 0) {
      this.prev = undefined;
      return undefined;
    }

    // Freshest first; ties broken by source key so the choice is deterministic
    // under equal timestamps (fake timers in tests, coarse clocks in practice).
    candidates.sort(
      (a, b) => a.silentMs - b.silentMs || a.sourceId.localeCompare(b.sourceId),
    );
    const freshest = candidates[0]!;

    const incumbent = this.prev
      ? candidates.find((c) => c.sourceId === this.prev)
      : undefined;
    const holdIncumbent =
      incumbent !== undefined &&
      (incumbent.silentMs < STICKY_HOLD_MS || freshest.sourceId === incumbent.sourceId);
    const chosen = holdIncumbent ? incumbent : freshest;

    this.prev = chosen.sourceId;
    const clause = clauseFor(chosen);
    if (clause === undefined) return undefined;
    return {
      sourceId: chosen.sourceId,
      label: chosen.source.agentType ?? chosen.sourceId,
      clause,
      quiet: chosen.silentMs >= CHILD_QUIET_MS,
    };
  }

  /** Drop the sticky selection — call between turns so state never leaks. */
  reset(): void {
    this.prev = undefined;
  }
}

/**
 * Render a {@link ChildActivity} as the banner's detail clause.
 *
 * Kept separate from selection so the composition is trivially testable and so
 * the caller controls styling. Intentionally emits plain text with no ANSI: the
 * banner clamps and dims the whole line, and injecting escapes here would
 * corrupt its width math.
 */
export function formatChildActivity(activity: ChildActivity): string {
  return `${activity.label} · ${activity.clause}`;
}

/** Stats slice the banner reads off a {@link ProgressEvent}. */
export interface ChildBannerStats {
  toolUses: number;
  totalTokens: number;
  durationMs: number;
}

/**
 * Invariant: the banner's stats tail must describe the SAME actor its detail
 * clause names.
 *
 * The banner is fed from `lastProgressByTask`, which is parent-scoped and — while
 * the parent turn is parked awaiting `handle.runToResult` — frozen at the values
 * it held before the dispatch. Rendering the live child clause next to those
 * numbers puts two contradictory statements on one row: `pr796-fix · round 34`
 * beside `7 tool calls · 2m` after twenty-three minutes. That is worse than the
 * blank slot this feature replaced, because a live-looking clause invites the
 * operator to trust the counters beside it.
 *
 * So when the clause comes from a child, the stats come from the same child's
 * `SourceState`. `lastToolName` is deliberately dropped rather than inherited:
 * the parent's last tool is `agent`, and the spinner verb already names the
 * child's in-flight tool via `work-derived-verb.ts`, so `via <tool>` here would
 * be either wrong or redundant.
 *
 * Returns `undefined` when no child is worth naming, so the caller keeps the
 * parent's own event untouched.
 */
export function deriveChildBanner(
  ctx: {
    sources?: ReadonlyMap<string, SourceState>;
    childActivity?: ChildActivityTracker;
  },
  now: number = Date.now(),
): { activity: string; stats: ChildBannerStats } | undefined {
  if (!ctx.sources || !ctx.childActivity) return undefined;
  const picked = ctx.childActivity.select(ctx.sources, now);
  if (!picked) return undefined;
  const source = ctx.sources.get(picked.sourceId);
  if (!source) return undefined;
  return {
    activity: formatChildActivity(picked),
    stats: {
      toolUses: source.stats.toolUses,
      totalTokens: source.stats.tokens,
      // Child-scoped elapsed: measured from the child's own start, not the
      // turn's, so the number answers "how long has this agent been running".
      durationMs: Math.max(0, now - source.startedAt),
    },
  };
}

/**
 * Reserved task id for the synthetic banner event below. Mirrors the existing
 * reserved ids (`__rate_limit__` in stream-renderer-orchestrator.ts,
 * `__soft_stop__` in stream-renderer-lifecycle.ts). Never written INTO
 * `lastProgressByTask` — it exists only to satisfy `ProgressEvent.taskId`.
 */
export const CHILD_BANNER_TASK_ID = '__child_activity__';

/**
 * Invariant: both provider loops emit the parent's `progress` event AFTER the
 * round's tools have been dispatched and their results committed —
 * anthropic-direct/loop/tool-round.ts dispatches at :66, commits results at
 * :69, and only then yields `progress` at :101; openai-compatible/query.ts:651
 * has the same ordering. A foreground subagent therefore runs to completion
 * INSIDE a round whose `progress` has not been emitted yet, so on the parent's
 * first tool round `lastProgressByTask` is empty for the child's entire
 * lifetime and the banner's per-task render loop iterates zero times — the
 * child banner is computed and then silently discarded.
 *
 * This synthesizes the missing carrier so a live child still paints a row.
 * Stats are the child's own (see {@link deriveChildBanner}); `lastToolName`
 * and `summary` are deliberately absent — the caller passes the child's clause
 * as `activity`, which owns the detail slot, and a parent-scoped tool name
 * beside a child clause is the exact contradiction this module exists to
 * remove.
 */
export function childBannerEvent(stats: ChildBannerStats): ProgressEvent {
  return {
    taskId: CHILD_BANNER_TASK_ID,
    description: 'Working',
    totalTokens: stats.totalTokens,
    toolUses: stats.toolUses,
    durationMs: stats.durationMs,
  };
}
