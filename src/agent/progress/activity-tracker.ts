/**
 * Surface-agnostic subagent activity / stall tracking.
 *
 * The problem this solves: "has this child gone quiet?" was computed only inside
 * the REPL renderer, as private per-source state (`SourceState.lastEventAt` plus
 * `stalledTicks`). Telegram, the daemon, and the witness trace consume the same
 * child event stream but had no access to that judgement, so a stalled fan-out
 * looked identical to a healthy one on every surface except the terminal.
 *
 * Cadence is the whole design constraint. A `progress` event is emitted only at
 * tool-ROUND boundaries, so a child wedged mid-tool-call emits nothing at all —
 * meaning a timestamp carried on `ProgressEvent` can never detect the very case
 * operators care about. Liveness must therefore be sampled on EVERY event, which
 * is exactly what this tracker does and why it is not a field on a payload.
 *
 * Deliberately threshold-free: it reports elapsed silence and lets each surface
 * apply its own cutoff (the REPL keeps its established 30s soft / 60s hard
 * behaviour). Baking one number in here would silently redefine a tuned UX
 * constant on three surfaces at once.
 *
 * @module agent/progress/activity-tracker
 */

/** A child's liveness at one instant. */
export interface ActivitySnapshot {
  /** The subagent id this describes. */
  subagentId: string;
  /** Agent type when the dispatch reported one. */
  agentType?: string;
  /** Epoch ms of the most recent observed event. */
  lastActivityAt: number;
  /** Milliseconds of silence as of the sampling instant. */
  silentMs: number;
  /** True once the child has reported a terminal event. */
  settled: boolean;
}

/** Minimal shape this tracker needs — deliberately not the full OutputEvent. */
export interface ActivityNote {
  subagentId: string;
  agentType?: string;
  /** True for a terminal event (done / error), which stops silence accruing. */
  settled?: boolean;
  /** Override the observation clock; defaults to now. Used by tests. */
  at?: number;
}

interface Entry {
  agentType: string | undefined;
  lastActivityAt: number;
  settled: boolean;
}

/**
 * Tracks last-activity per subagent across a session.
 *
 * Not a singleton: one instance per session/surface, so parallel sessions cannot
 * bleed liveness into each other.
 */
export class ActivityTracker {
  private readonly entries = new Map<string, Entry>();

  /**
   * Record activity for one child.
   *
   * Contract: a settled child STAYS settled — a late-arriving trailing event
   * cannot resurrect it, because a resurrected child would restart the silence
   * clock and hide a wave that has actually finished.
   */
  note(note: ActivityNote): void {
    const at = note.at ?? Date.now();
    const existing = this.entries.get(note.subagentId);
    if (existing?.settled) return;
    this.entries.set(note.subagentId, {
      agentType: note.agentType ?? existing?.agentType,
      lastActivityAt: at,
      settled: note.settled ?? false,
    });
  }

  /** Milliseconds of silence for one child, or `undefined` if never seen. */
  silentMs(subagentId: string, now: number = Date.now()): number | undefined {
    const entry = this.entries.get(subagentId);
    if (!entry) return undefined;
    return Math.max(0, now - entry.lastActivityAt);
  }

  /**
   * Children whose silence meets or exceeds `thresholdMs`, quietest-last.
   *
   * Settled children are excluded — a finished child is not stalled, and
   * reporting it as such is the false-positive that erodes trust in the signal.
   */
  stalled(thresholdMs: number, now: number = Date.now()): ActivitySnapshot[] {
    return this.snapshot(now)
      .filter((s) => !s.settled && s.silentMs >= thresholdMs)
      .sort((a, b) => b.silentMs - a.silentMs);
  }

  /** Every tracked child, most-recently-active first. */
  snapshot(now: number = Date.now()): ActivitySnapshot[] {
    const out: ActivitySnapshot[] = [];
    for (const [subagentId, entry] of this.entries) {
      out.push({
        subagentId,
        ...(entry.agentType !== undefined ? { agentType: entry.agentType } : {}),
        lastActivityAt: entry.lastActivityAt,
        silentMs: Math.max(0, now - entry.lastActivityAt),
        settled: entry.settled,
      });
    }
    return out.sort((a, b) => a.silentMs - b.silentMs);
  }

  /** Count of children not yet settled. */
  runningCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (!entry.settled) n += 1;
    return n;
  }

  /** Forget one child — used when a job is joined or discarded. */
  forget(subagentId: string): void {
    this.entries.delete(subagentId);
  }

  /** Drop all tracking; call at turn/session boundaries. */
  reset(): void {
    this.entries.clear();
  }
}
