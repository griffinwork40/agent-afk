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
  type SessionFacet,
  type StoredSessionInput,
  type SubagentInvocation,
  type ToolEventInput,
} from './schema.js';

export interface DeriveOptions {
  /** Absolute path of the source session sidecar (recorded for provenance). */
  sourceSessionPath?: string;
  /** mtime (ms) of the source sidecar — used by the store for staleness. */
  sourceSessionMtimeMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  derivedAt?: Date;
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
function dedupeToolEvents(events: ToolEventInput[]): ToolEventInput[] {
  const byId = new Map<string, ToolEventInput>();
  const noId: ToolEventInput[] = [];
  for (const ev of events) {
    if (ev.toolUseId === undefined) noId.push(ev);
    else byId.set(ev.toolUseId, ev); // last write wins → real entry supersedes placeholder
  }
  return [...byId.values(), ...noId];
}

export function deriveSessionFacet(
  session: StoredSessionInput,
  options: DeriveOptions = {},
): SessionFacet {
  const turns = session.turns ?? [];
  const allEvents: ToolEventInput[] = dedupeToolEvents(turns.flatMap((t) => t.toolEvents ?? []));

  // --- mechanical: tool + error aggregation ---
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
  }

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

  let outcome: FacetOutcome;
  if (turns.length === 0) outcome = 'aborted';
  else if (lastAssistant.trim().length === 0) outcome = 'partially_achieved';
  else outcome = 'fully_achieved';

  // Skip-gate semantics (consumers compare primary_success === 'none' and read
  // friction_detail non-emptiness): 'none' for non-completing sessions.
  const succeeded = outcome === 'fully_achieved' || outcome === 'partially_achieved';
  const primarySuccess = succeeded
    ? oneLine(lastAssistant || firstPrompt || sessionType, 160) || sessionType
    : 'none';

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

  const facet: SessionFacet = {
    facet_version: FACET_VERSION,
    session_id: sessionId,
    source: source === 'telegram' ? 'telegram' : 'cli',
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
    tool_error_categories: toolErrorCategories,
    friction_counts: { ...toolErrorCategories },
    friction_detail: frictionDetail,

    outcome,
    primary_success: primarySuccess,
    world_changes: {
      files_written: filesWritten,
      files_edited: filesEdited,
      bash_commands: bashCommands,
      commits,
      mutated: filesWritten > 0 || filesEdited > 0 || commits > 0,
    },

    decisions: [],
    evidence_pointers: evidencePointers,
  };

  // Validate on the way out so callers can rely on a well-formed facet.
  return SessionFacetSchema.parse(facet);
}
