/**
 * Block-evasion and lost-work analyzer over parsed witness traces.
 *
 * Consumes the already-parsed `TraceEvent[]` produced by `parseTrace` and
 * emits three read-only reports:
 *
 *   1. **Block ledger** — counts of `hook_decision` hard-blocks per
 *      `reason`/`blockedTool` per ISO-week, split by session origin surface.
 *
 *   2. **Evasion candidates** — a hard-block followed within N tool calls by
 *      a *different* tool whose `name` implies the same effect-class (write,
 *      execute, network). Flagged with session id and sequence numbers.
 *
 *   3. **Lost-work candidates** — a hard-block followed by the session ending
 *      (closure/sealed) with NO subsequent successful call in the same
 *      effect-class, suggesting the blocked work was never recovered.
 *
 * ## What targets the detector CAN match
 *
 * Witness traces record tool *names* and `errorHead` snippets but NOT full
 * tool arguments (those live in `~/.afk/state/sessions/<id>/events.jsonl`).
 * Matching is therefore coarse-grained, based on the tool-name → effect-class
 * mapping below:
 *
 *   - `write`   — write_file, edit_file, patch_apply
 *   - `execute` — bash
 *   - `git`     — (the `git` tool, if present)
 *   - `web`     — browser_open, browser_act, web_request
 *
 * The detector CANNOT distinguish "wrote the same file" from "wrote any file"
 * because paths are not in the trace. It also cannot inspect `gh` verb
 * arguments or URL hostnames. These limitations are documented per field in
 * {@link EvasionCandidate}.
 *
 * ## Design constraints
 *
 * - Pure function: no I/O, no side effects, deterministic.
 * - No chalk / no raw process.env / no raw path strings (paths via paths.ts).
 * - Each exported function is well under the 200-line function ceiling.
 *
 * @module agent/trace/block-evasion-analyzer
 */

import type { TraceEvent, HookDecisionPayload, ToolCallPayload } from './types.js';

// ---------------------------------------------------------------------------
// Effect-class vocabulary
// ---------------------------------------------------------------------------

/**
 * Coarse effect class inferred from a tool name. Used to detect whether a
 * different tool after a block reaches the same *kind* of effect.
 *
 * NOTE: because tool args are not in the trace, two calls in the same class
 * may be completely unrelated (e.g. two `bash` calls doing different things).
 * Callers must treat evasion candidates as *signals for review*, not proof.
 */
export type EffectClass = 'write' | 'execute' | 'git' | 'web' | 'other';

const EFFECT_CLASS_MAP: Record<string, EffectClass> = {
  write_file: 'write',
  edit_file: 'write',
  patch_apply: 'write',
  bash: 'execute',
  git: 'git',
  browser_open: 'web',
  browser_act: 'web',
  web_request: 'web',
};

export function effectClassOf(toolName: string): EffectClass {
  return EFFECT_CLASS_MAP[toolName] ?? 'other';
}

// ---------------------------------------------------------------------------
// Block ledger
// ---------------------------------------------------------------------------

/** Key for grouping blocks: ISO-week + surface + rule/reason. */
export interface BlockLedgerKey {
  /** ISO year-week, e.g. `"2026-W42"`. */
  week: string;
  /** Session origin surface extracted from `session_init_start`. Falls back
   *  to `"unknown"` when the trace has no init phase. */
  surface: string;
  /** `hook_decision.payload.blockedTool`, or `"(unknown)"` when absent. */
  blockedTool: string;
  /** `hook_decision.payload.reason`, or `"(none)"` when absent. */
  reason: string;
}

export interface BlockLedgerRow extends BlockLedgerKey {
  count: number;
}

/** Return ISO year-week string (`"YYYY-Www"`) for a UTC ISO timestamp. */
function isoWeek(ts: string): string {
  const d = new Date(ts);
  // ISO week: Thursday rule.
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = Math.ceil(((thursday.getTime() - jan4.getTime()) / 86_400_000 + (jan4.getUTCDay() || 7) - 3) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Aggregate hard-block events into a ledger sorted by week desc, then count desc.
 *
 * Only `hook_decision` rows with `approvalOutcome: 'hard-block'` are counted.
 * Plain `decision: 'block'` rows WITHOUT `approvalOutcome` are NOT included —
 * the issue specifically targets the no-prompt automatic ceiling refusals.
 */
export function buildBlockLedger(
  _sessionId: string,
  events: TraceEvent[],
  surface: string,
): BlockLedgerRow[] {
  const counts = new Map<string, BlockLedgerRow>();

  for (const ev of events) {
    if (ev.kind !== 'hook_decision') continue;
    const p = ev.payload as HookDecisionPayload;
    if (p.approvalOutcome !== 'hard-block') continue;

    const key: BlockLedgerKey = {
      week: isoWeek(ev.ts),
      surface,
      blockedTool: p.blockedTool ?? '(unknown)',
      reason: p.reason ?? '(none)',
    };
    const k = JSON.stringify(key);
    const existing = counts.get(k);
    if (existing) {
      existing.count++;
    } else {
      counts.set(k, { ...key, count: 1 });
    }
  }

  return [...counts.values()].sort((a, b) =>
    b.week.localeCompare(a.week) || b.count - a.count,
  );
}

// ---------------------------------------------------------------------------
// Evasion detector
// ---------------------------------------------------------------------------

/**
 * A detected evasion candidate.
 *
 * **Limitations** (both documented here and in the module JSDoc):
 * - `differentTool` matched the same *effect class*, not the same target path
 *   or resource — tool args are not in the trace.
 * - A `bash` after a blocked `bash` looks like an evasion even if the
 *   commands are unrelated. Review is always required.
 */
export interface EvasionCandidate {
  sessionId: string;
  /** Sequence number of the `hook_decision` hard-block event. */
  blockSeq: number;
  /** Timestamp of the block. */
  blockTs: string;
  /** The tool that was blocked. */
  blockedTool: string;
  /** Reason from the hook decision. */
  reason: string;
  /** Effect class of the blocked tool. */
  effectClass: EffectClass;
  /** Sequence number of the succeeding tool call in the same effect class. */
  evasionSeq: number;
  /** The tool that reached the same effect class after the block. */
  differentTool: string;
  /** How many tool-call events separated block from evasion candidate. */
  toolCallDistance: number;
  /**
   * NOTE: target matching is not possible from witness traces alone.
   * Full tool arguments are in `~/.afk/state/sessions/<id>/events.jsonl`.
   */
  targetMatchUnavailable: true;
}

/**
 * Scan events for evasion candidates: a hard-block followed within
 * `windowSize` tool-call events by a DIFFERENT tool in the same effect class.
 *
 * Default window: 10 tool calls (configurable to match "within N tool calls"
 * from the issue spec).
 */
export function detectEvasions(
  sessionId: string,
  events: TraceEvent[],
  windowSize = 10,
): EvasionCandidate[] {
  const candidates: EvasionCandidate[] = [];

  // Collect indices of hard-block events.
  const blockIndices: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind !== 'hook_decision') continue;
    const p = ev.payload as HookDecisionPayload;
    if (p.approvalOutcome === 'hard-block') blockIndices.push(i);
  }

  for (const bi of blockIndices) {
    const blockEv = events[bi]!;
    const bp = blockEv.payload as HookDecisionPayload;
    const blockedTool = bp.blockedTool ?? '(unknown)';
    const blockedClass = effectClassOf(blockedTool);

    // Actor scoping: only count tool calls from the same actor.
    // absent subagentId = root session.
    const blockActor: string | undefined = bp.subagentId;

    // Scan forward up to windowSize *completed* tool_call events
    // from the same actor.
    let toolCallsSeen = 0;
    let blockedToolOwnCompletionSkipped = false; // guard: skip only the first isError of the blocked tool
    for (let j = bi + 1; j < events.length && toolCallsSeen < windowSize; j++) {
      const ev = events[j]!;
      if (ev.kind !== 'tool_call') continue;
      const p = ev.payload as ToolCallPayload;
      if (p.phase !== 'completed') continue;

      // Scope to same actor (subagentId match; both undefined = root).
      if (p.subagentId !== blockActor) continue;

      // Exclude the blocked call's own (failed) completion: same tool name +
      // isError, but only once — a later unrelated failure of the same tool
      // must consume a window slot normally so the window does not extend
      // indefinitely (#3796).
      if (p.name === blockedTool && p.isError && !blockedToolOwnCompletionSkipped) {
        blockedToolOwnCompletionSkipped = true;
        continue;
      }

      toolCallsSeen++;
      const name = p.name;
      if (name === blockedTool) continue; // same tool — skip (would be a repeat, not evasion)
      if (blockedClass === 'other') continue; // can't classify

      const evClass = effectClassOf(name);
      if (evClass !== blockedClass) continue;
      if (!p.isError) {
        candidates.push({
          sessionId,
          blockSeq: blockEv.seq,
          blockTs: blockEv.ts,
          blockedTool,
          reason: bp.reason ?? '(none)',
          effectClass: blockedClass,
          evasionSeq: ev.seq,
          differentTool: name,
          toolCallDistance: toolCallsSeen,
          targetMatchUnavailable: true,
        });
        break; // one evasion per block
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Lost-work detector
// ---------------------------------------------------------------------------

/**
 * A detected lost-work candidate: a hard-block followed by session end with
 * no successful tool call in the same effect class afterward.
 */
export interface LostWorkCandidate {
  sessionId: string;
  /** Sequence number of the `hook_decision` hard-block event. */
  blockSeq: number;
  blockTs: string;
  blockedTool: string;
  reason: string;
  effectClass: EffectClass;
  /** How the session ended (`closure.reason` or `session_sealed.status`). */
  closureReason: string;
  /**
   * NOTE: "same effect" means same tool-name class, not same target.
   * Tool args are not available in witness traces.
   */
  targetMatchUnavailable: true;
}

/**
 * Detect blocks where the session ended without any successful call in the
 * same effect class after the block.
 */
export function detectLostWork(
  sessionId: string,
  events: TraceEvent[],
): LostWorkCandidate[] {
  const candidates: LostWorkCandidate[] = [];

  // Determine closure reason from the last applicable terminal event.
  // A trace without any terminal event (closure / session_sealed / abort)
  // is considered live — lost-work detection does not apply.
  let closureReason: string | undefined;
  for (const ev of events) {
    if (ev.kind === 'closure') {
      closureReason = (ev.payload as { reason: string }).reason;
    } else if (ev.kind === 'session_sealed') {
      closureReason = (ev.payload as { status: string }).status;
    } else if (ev.kind === 'abort') {
      closureReason ??= 'abort';
    }
  }

  // No terminal event — session is still live; skip lost-work analysis.
  if (closureReason == null) return candidates;

  // For each hard-block, check whether any successful call in the same class
  // by the same actor follows before session end.
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind !== 'hook_decision') continue;
    const p = ev.payload as HookDecisionPayload;
    if (p.approvalOutcome !== 'hard-block') continue;

    const blockedTool = p.blockedTool ?? '(unknown)';
    const blockedClass = effectClassOf(blockedTool);
    if (blockedClass === 'other') continue;

    // Actor scoping: same subagentId (both undefined = root).
    const blockActor: string | undefined = p.subagentId;

    let recovered = false;
    for (let j = i + 1; j < events.length; j++) {
      const fev = events[j]!;
      if (fev.kind !== 'tool_call') continue;
      const fp = fev.payload as ToolCallPayload;
      if (fp.phase !== 'completed') continue;
      if (fp.isError) continue;
      if (fp.subagentId !== blockActor) continue;
      if (effectClassOf(fp.name) === blockedClass) {
        recovered = true;
        break;
      }
    }

    if (!recovered) {
      candidates.push({
        sessionId,
        blockSeq: ev.seq,
        blockTs: ev.ts,
        blockedTool,
        reason: p.reason ?? '(none)',
        effectClass: blockedClass,
        closureReason,
        targetMatchUnavailable: true,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Combined report
// ---------------------------------------------------------------------------

export interface BlockEvasionReport {
  sessionId: string;
  surface: string;
  blockLedger: BlockLedgerRow[];
  evasions: EvasionCandidate[];
  lostWork: LostWorkCandidate[];
}

/**
 * Run all three analyses over a single parsed session and return a combined
 * report. Pure: no I/O.
 *
 * @param sessionId - The session identifier (used as a label in output).
 * @param events    - Parsed trace events from `parseTrace`.
 * @param opts      - Optional tuning: `evasionWindow` (default 10).
 */
export function analyzeBlockEvasion(
  sessionId: string,
  events: TraceEvent[],
  opts: { evasionWindow?: number } = {},
): BlockEvasionReport {
  // Derive session surface from the first session_init_start phase event.
  let surface = 'unknown';
  for (const ev of events) {
    if (ev.kind === 'session_phase') {
      const p = ev.payload as { phase: string; origin?: string };
      if (p.phase === 'session_init_start' && p.origin) {
        surface = p.origin;
        break;
      }
    }
  }

  return {
    sessionId,
    surface,
    blockLedger: buildBlockLedger(sessionId, events, surface),
    evasions: detectEvasions(sessionId, events, opts.evasionWindow ?? 10),
    lostWork: detectLostWork(sessionId, events),
  };
}

// ---------------------------------------------------------------------------
// Text formatter (no chalk — plain text suitable for stdout)
// ---------------------------------------------------------------------------

/**
 * Format a {@link BlockEvasionReport} as human-readable plain text.
 * No color — callers may pipe through chalk if needed.
 */
export function formatBlockEvasionReport(report: BlockEvasionReport): string {
  const lines: string[] = [];
  const { sessionId, surface, blockLedger, evasions, lostWork } = report;

  lines.push(`Block-Evasion Report  ${sessionId}  (surface: ${surface})`);
  lines.push('='.repeat(72));

  // 1. Block ledger
  lines.push('');
  lines.push('§1  Block ledger (hard-blocks only)');
  lines.push('-'.repeat(40));
  if (blockLedger.length === 0) {
    lines.push('  (no hard-blocks recorded)');
  } else {
    for (const row of blockLedger) {
      lines.push(
        `  ${row.week}  ${row.surface.padEnd(10)}  ${String(row.count).padStart(4)}×  ` +
        `tool=${row.blockedTool}  reason=${row.reason}`,
      );
    }
  }

  // 2. Evasion candidates
  lines.push('');
  lines.push(`§2  Evasion candidates  (window=${report.evasions.length > 0 ? 'varies' : 'n/a'})`);
  lines.push('  NOTE: target matching unavailable — tool args not in witness trace');
  lines.push('-'.repeat(40));
  if (evasions.length === 0) {
    lines.push('  (none detected)');
  } else {
    for (const e of evasions) {
      lines.push(
        `  seq=${e.blockSeq} @ ${e.blockTs}  blocked=${e.blockedTool}  ` +
        `class=${e.effectClass}  evaded-via=${e.differentTool}  ` +
        `dist=${e.toolCallDistance}  reason=${e.reason}`,
      );
    }
  }

  // 3. Lost-work candidates
  lines.push('');
  lines.push('§3  Lost-work candidates');
  lines.push('  NOTE: target matching unavailable — tool args not in witness trace');
  lines.push('-'.repeat(40));
  if (lostWork.length === 0) {
    lines.push('  (none detected)');
  } else {
    for (const l of lostWork) {
      lines.push(
        `  seq=${l.blockSeq} @ ${l.blockTs}  blocked=${l.blockedTool}  ` +
        `class=${l.effectClass}  closure=${l.closureReason}  reason=${l.reason}`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}
