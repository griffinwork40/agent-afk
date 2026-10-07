/**
 * deriveSessionFacet — pure function: StoredSessionInput → validated SessionFacet.
 *
 * No I/O, no clock reads unless injected (see DeriveOptions.derivedAt) — so it
 * is deterministic and trivially testable. The store layer (store.ts) handles
 * disk reads, caching, and staleness.
 *
 * Derivation tiers:
 *   - MECHANICAL (exact): tool_counts, tool_errors/categories, world_changes,
 *     durations, message counts, subagent invocations, evidence pointers.
 *   - SEMANTIC (heuristic, v1): underlying_goal (= first prompt, capped),
 *     goal_categories, session_type, brief_summary, outcome, primary_success.
 *     `decisions` is intentionally empty in v1 — it needs an LLM digest pass.
 */

import { basename } from 'path';
import {
  FACET_VERSION,
  SessionFacetSchema,
  type FacetOutcome,
  type FacetOutcomeDowngradeReason,
  type FacetOutcomeSource,
  type SessionFacet,
  type StoredSessionInput,
  type SubagentInvocation,
  type SubagentToolSummary,
  type ToolEventInput,
  type YieldTracking,
} from './schema.js';
import { computeParallelDispatch } from './parallel-dispatch.js';
import { parseTerminalState } from '../outcomes/terminal-state.js';
import { detectPrUrlFromEvents } from './derive.pr-detect.js';
import type { TraceSignals } from './derive.trace.js';
import { checkDowngradeSignals } from './derive.downgrade.js';

export interface DeriveOptions {
  /** Absolute path of the source session sidecar (recorded for provenance). */
  sourceSessionPath?: string;
  /** mtime (ms) of the source sidecar — used by the store for staleness. */
  sourceSessionMtimeMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  derivedAt?: Date;
  /**
   * Journal-derived tool events for the PARENT session only (subagent tool
   * calls excluded). When provided, these replace the sidecar `turns[].toolEvents`
   * for tool aggregation so compacted-away calls still count.
   * Populated by `store.ts` when a journal is available. (#2461)
   */
  journalEvents?: ToolEventInput[];
  /**
   * Per-subagent breakdown from the journal's subagent files. Stored as an
   * optional field in the facet; subagent tool calls are NOT added to the
   * parent's `tool_counts`. (#2461)
   */
  subagentBreakdown?: SubagentToolSummary[];
  /**
   * Signals extracted from the session's witness trace by the store layer.
   * When absent (no trace available, or tracing disabled) all trace-backed
   * downgrade signals are suppressed — absence is never treated as a
   * downgrade. Populated by `store.ts` via `derive.trace.ts`. (#2798 cont.)
   */
  traceSignals?: TraceSignals;
}

const SUBAGENT_TOOLS = new Set(['agent', 'compose', 'skill']);
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);
const GOAL_CAP = 1000;
const SUMMARY_CAP = 240;
const EVIDENCE_CAP = 50;
// `(?![\w-])` rejects `git commit-tree` / `git commits` (a trailing word char or
// hyphen) while still matching `git commit`, `git commit -m …`, `git commit;`.
const COMMIT_RE = /\bgit\s+commit(?![\w-])/;
const SLASH_CMD_RE = /^\s*\/([a-zA-Z][\w-]*)/;

/**
 * Map a parsed TerminalKind to a FacetOutcome.
 * Mapping: done -> fully_achieved; asking -> partially_achieved;
 *          blocked -> not_achieved; interrupted -> aborted.
 */
function terminalKindToOutcome(kind: string): FacetOutcome {
  if (kind === 'done') return 'fully_achieved';
  if (kind === 'asking') return 'partially_achieved';
  if (kind === 'blocked') return 'not_achieved';
  if (kind === 'interrupted') return 'aborted';
  return 'unknown';
}

interface OutcomeResult {
  outcome: FacetOutcome;
  outcomeSource: FacetOutcomeSource;
  primarySuccess: string;
  /** Non-empty when the Done block had a deferred/pending bullet (#2798). */
  parsedDeferred: string | undefined;
  /** Non-empty when the Done block had an evidence bullet (#2798). */
  parsedEvidence: string | undefined;
}

/**
 * Derive outcome, outcome_source, and primary_success from the turns array.
 * Extracted to keep deriveSessionFacet under the 200-line function ceiling.
 */
function deriveOutcome(
  turns: StoredSessionInput['turns'],
  sessionType: string,
): OutcomeResult {
  const lastAssistant =
    [...(turns ?? [])].reverse().find((t) => (t.assistant ?? '').trim().length > 0)?.assistant ?? '';
  // Determine outcome and outcome_source (#2777):
  //   - zero turns → 'aborted' (structural)
  //   - empty last assistant → 'partially_achieved' (structural)
  //   - terminal-state heading found → mapped kind (terminal_state)
  //   - non-empty assistant, no heading → 'unknown' (none)
  let outcome: FacetOutcome;
  let outcomeSource: FacetOutcomeSource;
  let whatWasDone: string | undefined;

  const tArr = turns ?? [];
  let parsedDeferred: string | undefined;
  let parsedEvidence: string | undefined;
  if (tArr.length === 0) {
    outcome = 'aborted';
    outcomeSource = 'structural';
  } else if (lastAssistant.trim().length === 0) {
    outcome = 'partially_achieved';
    outcomeSource = 'structural';
  } else {
    const parsed = parseTerminalState(lastAssistant);
    if (parsed !== null) {
      outcome = terminalKindToOutcome(parsed.kind);
      outcomeSource = 'terminal_state';
      whatWasDone = parsed.whatWasDone;
      // Capture deferred and evidence bullets for downgrade signals (#2798).
      // Only meaningful when kind is 'done'; other kinds are ignored downstream.
      parsedDeferred = parsed.deferred;
      parsedEvidence = parsed.evidence;
    } else {
      outcome = 'unknown';
      outcomeSource = 'none';
    }
  }

  // primary_success (#2777):
  //   - Done + whatWasDone parsed → oneLine(whatWasDone, 160)
  //   - Done, no whatWasDone → existing behavior (lastAssistant fallback)
  //   - partially_achieved (empty/structural) → firstPrompt or sessionType
  //   - not_achieved / aborted → 'none'
  //   - unknown → existing last-assistant fallback (not 'none')
  const firstPrompt = tArr[0]?.user ?? '';
  let primarySuccess: string;
  if (outcome === 'not_achieved' || outcome === 'aborted') {
    primarySuccess = 'none';
  } else if (outcome === 'fully_achieved') {
    primarySuccess = whatWasDone
      ? oneLine(whatWasDone, 160) || sessionType
      : oneLine(lastAssistant || firstPrompt || sessionType, 160) || sessionType;
  } else {
    primarySuccess = oneLine(lastAssistant || firstPrompt || sessionType, 160) || sessionType;
  }

  return { outcome, outcomeSource, primarySuccess, parsedDeferred, parsedEvidence };
}

/** Parse a stringified tool input to an object, swallowing malformed JSON. */
function parseInput(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Collapse whitespace and cap length for single-line summary fields. */
function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function humanizeName(name: string): string {
  return name.replace(/[-_]+/g, ' ').trim();
}

function classifySessionType(firstPrompt: string, source: string): string {
  if (SLASH_CMD_RE.test(firstPrompt)) return 'slash_command';
  if (source === 'telegram') return 'chat';
  return 'task';
}

/**
 * Invariant: the recorder persists TWO ToolEvent entries per tool call under one
 * toolUseId — an early placeholder emitted at content_block_start (translate.ts:
 * input ' …', no inputRaw, no result) and the real entry emitted post-stream
 * (loop.ts: summarized input + result). Both are pushed to the turn's toolEvents
 * array (turn-handler.ts / background.ts), so counting raw events double-counts
 * every tool. The real entry is always emitted AFTER its placeholder, so a
 * last-write-wins Map keyed by toolUseId keeps the real one; Map iteration order
 * preserves each id's first-seen position (call order). Events without a
 * toolUseId cannot be paired and are kept individually.
 */
export function dedupeToolEvents(events: ToolEventInput[]): ToolEventInput[] {
  const byId = new Map<string, ToolEventInput>();
  const noId: ToolEventInput[] = [];
  for (const ev of events) {
    if (ev.toolUseId === undefined) noId.push(ev);
    else byId.set(ev.toolUseId, ev); // last write wins → real entry supersedes placeholder
  }
  return [...byId.values(), ...noId];
}

interface AggregateToolEventsResult {
  toolCounts: Record<string, number>;
  toolErrorCategories: Record<string, number>;
  subagents: SubagentInvocation[];
  skills: string[];
  evidencePaths: string[];
  toolErrors: number;
  filesWritten: number;
  filesEdited: number;
  bashCommands: number;
  commits: number;
  /** GitHub PR URL from a gh pr create result, if found. */
  detectedPrUrl: string | null;
  /** Compose calls with >=1 node that wound down partial (#2970). */
  composePartialNodes: number;
  /** Partial compose nodes summed across calls (#2978). */
  composePartialNodeCount: number;
}

function aggregateToolEvents(allEvents: ToolEventInput[]): AggregateToolEventsResult {
  const toolCounts: Record<string, number> = {};
  const toolErrorCategories: Record<string, number> = {};
  const subagents: SubagentInvocation[] = [];
  const skills: string[] = [];
  const evidencePaths: string[] = [];
  let toolErrors = 0;
  let filesWritten = 0;
  let filesEdited = 0;
  let bashCommands = 0;
  let commits = 0;
  let composePartialNodes = 0;
  let composePartialNodeCount = 0;
  for (const ev of allEvents) {
    const name = ev.toolName;
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;

    if (ev.isError === true) {
      toolErrors += 1;
      toolErrorCategories[name] = (toolErrorCategories[name] ?? 0) + 1;
    }

    // Prefer inputRaw (full JSON, populated for sessions recorded after this fix) over
    // input (summarized string). For older sidecars without inputRaw, parseInput falls
    // back to input — which will still return undefined for summarized strings, preserving
    // the pre-fix behaviour rather than crashing.
    const parsed = parseInput(ev.inputRaw ?? ev.input);

    if (name === 'write_file') filesWritten += 1;
    if (name === 'edit_file') filesEdited += 1;
    if (name === 'bash') {
      bashCommands += 1;
      // Commit detection reads the parsed `command` when present (older sidecars
      // written before the secret-at-rest fix) and otherwise falls back to the
      // summarized `input` (a flattened, ≤160-char one-line summary — newlines
      // collapsed to spaces; see summarizeToolInput). The raw `command` is no
      // longer persisted to inputRaw — it can carry inline secrets verbatim — so
      // for current sidecars detection runs against that summary, which catches a
      // `git commit` anywhere in the flattened command (not just line 1). See
      // raw-input.ts.
      const cmd = asString(parsed?.['command']) ?? ev.input;
      if (cmd && COMMIT_RE.test(cmd)) commits += 1;

    }

    if (FILE_TOOLS.has(name)) {
      const fp = asString(parsed?.['file_path']);
      if (fp && !evidencePaths.includes(fp) && evidencePaths.length < EVIDENCE_CAP) {
        evidencePaths.push(fp);
      }
    }

    if (SUBAGENT_TOOLS.has(name)) {
      let label: string | undefined;
      if (name === 'skill') {
        label = asString(parsed?.['name']);
        if (label && !skills.includes(label)) skills.push(label);
      } else if (name === 'agent') {
        label = asString(parsed?.['id_prefix']);
      } else {
        label = 'compose';
      }
      subagents.push(label ? { tool: name, label } : { tool: name });
    }

    // Count compose calls that had at least one partial node (#2970).
    // ev.incomplete is set by the compose executor when result.partial.length > 0.
    if (name === 'compose' && ev.incomplete === true) {
      composePartialNodes += 1;
      // #2978: per-node count. A call without a recorded count (pre-#2978)
      // had at least one partial node, so it contributes 1.
      const n = ev.partialNodeCount;
      composePartialNodeCount += typeof n === 'number' && n > 0 ? n : 1;
    }
  }

  // PR detection (#2777, #2795): delegate to the shared helper so subagent
  // journals can reuse identical logic via journal-adapter.ts.
  const detectedPrUrl = detectPrUrlFromEvents(allEvents);

  return { toolCounts, toolErrorCategories, subagents, skills, evidencePaths, toolErrors, filesWritten, filesEdited, bashCommands, commits, detectedPrUrl, composePartialNodes, composePartialNodeCount };
}

export function deriveSessionFacet(
  session: StoredSessionInput,
  options: DeriveOptions = {},
): SessionFacet {
  const turns = session.turns ?? [];
  // When journal events are supplied (post-#2461), they replace the sidecar
  // toolEvents for aggregation — they are already deduped by the adapter.
  // The sidecar path is kept as the fallback for older sessions or when the
  // journal is unavailable / disabled.
  const allEvents: ToolEventInput[] = options.journalEvents !== undefined
    ? options.journalEvents
    : dedupeToolEvents(turns.flatMap((t) => t.toolEvents ?? []));

  // --- mechanical: tool + error aggregation ---
  const { toolCounts, toolErrorCategories, subagents, skills, evidencePaths, toolErrors, filesWritten, filesEdited, bashCommands, commits, detectedPrUrl, composePartialNodes, composePartialNodeCount } = aggregateToolEvents(allEvents);

  // tool_errors_total = parent tool_errors + sum of per-subagent tool_errors (#2777)
  const subagentToolErrorsTotal = (options.subagentBreakdown ?? [])
    .reduce((acc, s) => acc + s.tool_errors, 0);
  const toolErrorsTotal = toolErrors + subagentToolErrorsTotal;

  // Subagent PR detection (#2795 gap 6): if a subagent opened a PR that the
  // parent did not detect, promote the subagent URL. Last non-null wins —
  // same policy as the parent path. Parent URL takes precedence (already set).
  const effectivePrUrl: string | null = detectedPrUrl ??
    (options.subagentBreakdown ?? []).reduce<string | null>(
      (acc, s) => s.detected_pr_url ?? acc,
      null,
    );

  // --- semantic (heuristic) ---
  const firstPrompt = turns[0]?.user ?? '';
  const source = session.source ?? 'cli';
  const sessionType = classifySessionType(firstPrompt, source);

  const commands: string[] = [];
  for (const t of turns) {
    const m = SLASH_CMD_RE.exec(t.user ?? '');
    const cmd = m?.[1];
    if (cmd && !commands.includes(cmd)) commands.push(cmd);
  }

  const userMessageCount = turns.filter((t) => (t.user ?? '').trim().length > 0).length;
  const assistantMessageCount = turns.filter((t) => (t.assistant ?? '').trim().length > 0).length;
  const lastAssistant = [...turns].reverse().find((t) => (t.assistant ?? '').trim().length > 0)?.assistant ?? '';

  const { outcome: rawOutcome, outcomeSource, primarySuccess: rawPrimarySuccess, parsedDeferred, parsedEvidence } = deriveOutcome(turns, sessionType);

  // Downgrade self-reported Done to partially_achieved when corroborating
  // signals indicate the session did not fully complete (#2798). The check
  // only applies when the initial outcome is fully_achieved; other outcomes
  // are not modified. primarySuccess is preserved as-is — it still describes
  // what the agent reported doing.
  let outcome = rawOutcome;
  let primarySuccess = rawPrimarySuccess;
  let outcomeDowngradeReason: FacetOutcomeDowngradeReason | undefined;
  if (rawOutcome === 'fully_achieved') {
    outcomeDowngradeReason = checkDowngradeSignals({
      parsedDeferred,
      parsedEvidence,
      filesWritten,
      filesEdited,
      commits,
      composePartialNodes,
      traceSignals: options.traceSignals,
    });
    if (outcomeDowngradeReason !== undefined) {
      outcome = 'partially_achieved';
      // Keep primarySuccess from the Done block — it still describes what the
      // agent reported. Only the outcome label changes to reflect the doubt.
    }
  }

  const frictionDetail =
    toolErrors > 0
      ? `${toolErrors} tool error(s): ${Object.entries(toolErrorCategories)
          .map(([k, v]) => `${k}×${v}`)
          .join(', ')}`
      : '';

  const summaryHead = session.name ? humanizeName(session.name) : oneLine(firstPrompt, 80);
  const summaryTail = oneLine(lastAssistant || firstPrompt, SUMMARY_CAP);
  const briefSummary = oneLine(summaryHead ? `${summaryHead} — ${summaryTail}` : summaryTail, 400) || 'empty session';

  const sessionId =
    session.sessionId ??
    (options.sourceSessionPath ? basename(options.sourceSessionPath, '.json') : 'unknown');

  const durationMs =
    session.totalDurationMs && session.totalDurationMs > 0
      ? session.totalDurationMs
      : Math.max(0, session.savedAt - session.startedAt);

  const evidencePointers = options.sourceSessionPath
    ? [...evidencePaths, options.sourceSessionPath]
    : evidencePaths;

  // Yield tracking: is_scheduled_session is mechanical (from source); produced_pr
  // and pr_merged require async git/gh probes run by the session-end hook after
  // teardown, so they start as null here and are written back by that hook.
  // Exception: when derive detects a `gh pr create` URL in bash output (#2777,
  // #2795), set produced_pr=true and record the URL immediately. effectivePrUrl
  // covers both the parent session and any subagent-opened PR (#2795 gap 6).
  // Never set false here.
  const yieldTracking: YieldTracking = {
    is_scheduled_session: source === 'daemon',
    produced_pr: effectivePrUrl !== null ? true : null,
    pr_merged: null,
    ...(effectivePrUrl !== null ? { pr_url: effectivePrUrl } : { pr_url: null }),
  };

  const facet: SessionFacet = {
    facet_version: FACET_VERSION,
    session_id: sessionId,
    source: source === 'telegram' ? 'telegram' : source === 'web' ? 'web' : source === 'daemon' ? 'daemon' : 'cli',
    model: session.model,
    derived_at: (options.derivedAt ?? new Date()).toISOString(),
    derived_from: 'afk-session',
    source_session_path: options.sourceSessionPath ?? '',
    source_session_mtime_ms: options.sourceSessionMtimeMs ?? session.savedAt,
    subagent_persistence: 'not_persisted',

    start_time: new Date(session.startedAt).toISOString(),
    end_time: new Date(session.savedAt).toISOString(),
    duration_minutes: Number((durationMs / 60000).toFixed(2)),

    underlying_goal: firstPrompt.slice(0, GOAL_CAP),
    first_prompt: firstPrompt.slice(0, GOAL_CAP),
    goal_categories: { [sessionType]: 1 },
    session_type: sessionType,
    brief_summary: briefSummary,

    total_turns: turns.length,
    user_message_count: userMessageCount,
    assistant_message_count: assistantMessageCount,
    tool_counts: toolCounts,
    commands,
    skills,
    subagents,

    tool_errors: toolErrors,
    tool_errors_total: toolErrorsTotal,
    tool_error_categories: toolErrorCategories,
    friction_counts: { ...toolErrorCategories },
    friction_detail: frictionDetail,
    // Compose calls with >=1 partial node (#2970); omitted when zero.
    ...(composePartialNodes > 0 ? { compose_partial_nodes: composePartialNodes } : {}),
    // Partial compose nodes summed across calls (#2978); omitted when zero.
    ...(composePartialNodeCount > 0 ? { compose_partial_node_count: composePartialNodeCount } : {}),

    outcome,
    outcome_source: outcomeSource,
    // outcome_downgrade_reason: present only when a downgrade fired (#2798).
    ...(outcomeDowngradeReason !== undefined ? { outcome_downgrade_reason: outcomeDowngradeReason } : {}),
    primary_success: primarySuccess,
    world_changes: {
      files_written: filesWritten,
      files_edited: filesEdited,
      bash_commands: bashCommands,
      commits,
      mutated: filesWritten > 0 || filesEdited > 0 || commits > 0,
    },

    parallel_dispatch: computeParallelDispatch(turns),

    // session yield tracking (#2016) — pr fields enriched asynchronously by session-end hook
    yield_tracking: yieldTracking,

    decisions: [],
    evidence_pointers: evidencePointers,

    // Subagent breakdown: populated from journal subagent files when available.
    // Absent when journal is disabled or no subagent journals exist. (#2461)
    ...(options.subagentBreakdown !== undefined && options.subagentBreakdown.length > 0
      ? { subagent_breakdown: options.subagentBreakdown }
      : {}),
  };

  // Populate token_breakdown when cost data is available.
  // Per-direction fields (input/output/cache_read/cache_creation) are omitted:
  // StoredSession only carries totalTokens (a scalar sum) and does not persist
  // per-direction counts. Omitting them avoids zero-filling fields that would
  // falsely imply actual per-direction measurements.
  if (session.totalCostUsd != null) {
    facet.token_breakdown = {
      cost_usd: session.totalCostUsd,
    };
  }

  // Validate on the way out so callers can rely on a well-formed facet.
  return SessionFacetSchema.parse(facet);
}
