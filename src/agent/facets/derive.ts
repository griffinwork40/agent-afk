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
import { BARE_PR_URL_RESULT, PR_QUERY_INPUT } from '../outcomes/artifacts.js';

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

// Invariant: a GitHub PR URL that is the whole of one output line. gh pr create
// prints the URL on its own line; a URL embedded in grep/rg output or prose is
// on a line with other text and does not match.
const GH_PR_URL_LINE_RE = /^[ \t]*(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+)[ \t]*$/gm;

// Invariant: `gh pr create` counts as an invocation only at the start of a
// line or right after a shell separator (`;`, `&&`, `||`, `|`), optionally
// after env assignments (`GH_TOKEN=x gh pr create`). This rejects the phrase
// as an argument (rg -n "gh pr create" src). It is an approximation: a
// separator inside a quoted string can still match.
const GH_PR_CREATE_INVOCATION_RE =
  /(?:^|[;|&])[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*gh[ \t]+pr[ \t]+create(?:[ \t]|$)/m;

/** Last GitHub PR URL that sits alone on an output line, or null. */
function lastOwnLinePrUrl(result: string): string | null {
  let url: string | null = null;
  for (const m of result.matchAll(GH_PR_URL_LINE_RE)) url = m[1] ?? url;
  return url;
}

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
  let detectedPrUrl: string | null = null;

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

      // PR detection (#2777): when a bash event whose input looks like a real
      // `gh pr create` invocation has a result containing a GitHub PR URL on
      // its own line, record the URL. The LAST URL wins (in case of multiple).
      // We never set produced_pr=false here — that is left to the async yield probe.
      // Truncated-input path: if the stored input ends in '…', the command may
      // have been cut before `gh pr create`; treat a bare-PR-URL result with a
      // non-query truncated input the same as artifacts.ts does.
      if (ev.isError !== true && ev.result) {
        const inputStr = asString(parsed?.['command']) ?? ev.input ?? '';
        const truncated = inputStr.trimEnd().endsWith('\u2026');
        // The truncated path requires the WHOLE result to be a bare PR URL
        // (gh pr create's stdout shape), same as artifacts.ts isPRCreateEvent.
        const isTruncatedCreate =
          truncated && BARE_PR_URL_RESULT.test(ev.result) && !PR_QUERY_INPUT.test(inputStr);
        if (GH_PR_CREATE_INVOCATION_RE.test(inputStr) || isTruncatedCreate) {
          detectedPrUrl = lastOwnLinePrUrl(ev.result) ?? detectedPrUrl;
        }
      }
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
  }

  return { toolCounts, toolErrorCategories, subagents, skills, evidencePaths, toolErrors, filesWritten, filesEdited, bashCommands, commits, detectedPrUrl };
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
  const { toolCounts, toolErrorCategories, subagents, skills, evidencePaths, toolErrors, filesWritten, filesEdited, bashCommands, commits, detectedPrUrl } = aggregateToolEvents(allEvents);

  // tool_errors_total = parent tool_errors + sum of per-subagent tool_errors (#2777)
  const subagentToolErrorsTotal = (options.subagentBreakdown ?? [])
    .reduce((acc, s) => acc + s.tool_errors, 0);
  const toolErrorsTotal = toolErrors + subagentToolErrorsTotal;

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

  // Determine outcome and outcome_source (#2777):
  //   - zero turns → 'aborted' (structural)
  //   - empty last assistant → 'partially_achieved' (structural)
  //   - terminal-state heading found → mapped kind (terminal_state)
  //   - non-empty assistant, no heading → 'unknown' (none)
  let outcome: FacetOutcome;
  let outcomeSource: FacetOutcomeSource;
  let whatWasDone: string | undefined;

  if (turns.length === 0) {
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
  let primarySuccess: string;
  if (outcome === 'not_achieved' || outcome === 'aborted') {
    primarySuccess = 'none';
  } else if (outcome === 'fully_achieved') {
    // Prefer the Done block's "What was done" bullet, parsed once above.
    if (whatWasDone) {
      primarySuccess = oneLine(whatWasDone, 160) || sessionType;
    } else {
      primarySuccess = oneLine(lastAssistant || firstPrompt || sessionType, 160) || sessionType;
    }
  } else {
    // partially_achieved or unknown — use existing fallback
    primarySuccess = oneLine(lastAssistant || firstPrompt || sessionType, 160) || sessionType;
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
  // Exception: when derive detects a `gh pr create` URL in bash output (#2777),
  // set produced_pr=true and record the URL immediately. Never set false here.
  const yieldTracking: YieldTracking = {
    is_scheduled_session: source === 'daemon',
    produced_pr: detectedPrUrl !== null ? true : null,
    pr_merged: null,
    ...(detectedPrUrl !== null ? { pr_url: detectedPrUrl } : { pr_url: null }),
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

    outcome,
    outcome_source: outcomeSource,
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
