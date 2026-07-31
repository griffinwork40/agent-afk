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

import { formatDuration, formatToolCallStat } from '../format-utils.js';
import { ORCHESTRATOR_SOURCE_KEY, type SourceState } from './stream-renderer-source.js';

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
 * Matches `PAUSE_THRESHOLD_MS` in stream-renderer-lifecycle.ts so the banner
 * and the tool-lane's `· waiting Xs` annotation agree rather than reporting two
 * different notions of "stalled". The lane keeps its own label (renamed to
 * `waiting` deliberately — see stream-renderer-visibility.test.ts); this adds
 * the same fact in the higher-salience slot where the eye already rests.
 */
export const CHILD_QUIET_MS = 30_000;

/** A running child worth naming in the banner detail slot. */
export interface ChildActivity {
  /** Source key (the subagent id). */
  sourceId: string;
  /** Human label — `agentType` when known, else the raw source key. */
  label: string;
  /** Progress clause, e.g. `round 3: Read tool-lane.ts` or `no output for 41s`. */
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
    return `no output for ${formatDuration(candidate.silentMs)}`;
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

/**
 * Banner-slot adapter: resolve the detail clause for a composed overlay, or
 * `undefined` when there is nothing live to report.
 *
 * Lives here rather than in stream-renderer-orchestrator.ts so that file (already
 * past the 350-line ceiling) gains a call site and no new concern. Tolerates both
 * fields being absent so non-TTY surfaces and existing tests keep their previous
 * behaviour with no ctx changes.
 */
export function deriveChildActivity(
  ctx: {
    sources?: ReadonlyMap<string, SourceState>;
    childActivity?: ChildActivityTracker;
  },
  now: number = Date.now(),
): string | undefined {
  if (!ctx.sources || !ctx.childActivity) return undefined;
  const activity = ctx.childActivity.select(ctx.sources, now);
  return activity ? formatChildActivity(activity) : undefined;
}
