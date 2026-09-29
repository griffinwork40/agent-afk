/**
 * `afk trace show --results`: full tool results from the message journal.
 *
 * The witness trace records only `resultBytes` / `errorHead` per tool call.
 * The message journal (`sessions/<sessionId>/journal.jsonl` plus
 * `subagents/*.jsonl`) holds the full content. This module bridges the two:
 * it resolves which journal(s) belong to a trace, then renders each completed
 * tool_call's result as an indented block under its row.
 *
 * Label <-> session bridge: a fresh session's witness dir is labelled with a
 * random UUID, not the session id. The trace's `session_id_assigned` phase
 * events carry the durable session id(s); the selector itself is also tried,
 * because `loadTrace` accepts a session id and maps it to the label through the
 * ledger's `meta.traceLabel`.
 *
 * @module cli/commands/trace-results
 */

import { findToolResult, journalExists } from '../../agent/journal/index.js';
import type { TraceEvent } from '../../agent/trace/index.js';
import { isSafeLedgerSessionId } from '../../paths.js';
import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';
import { toolResultToText } from '../../web-server/tool-result-text.js';

/** Default cap on printed lines per result; `--results-lines 0` lifts it. */
export const DEFAULT_RESULT_LINES = 40;

/** Width of `  HH:MM:SS  <label 9>  ` so result blocks sit under the detail column. */
const RESULT_INDENT = ' '.repeat(23) + '│ ';

/** Control bytes other than tab / newline, which would corrupt the terminal. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export interface TraceResultsContext {
  /** Rendered block for one tool call, or `null` to print nothing extra. */
  resultFor: (toolUseId: string) => string | null;
  /** Header note (journal session(s) used, or why there are none). */
  note: string;
}

/**
 * Candidate journal session ids for a trace, in priority order:
 * every `session_id_assigned` id (latest first), then the selector itself.
 * Unsafe ids are dropped; duplicates collapse.
 */
export function journalSessionCandidates(traceSessionId: string, events: readonly TraceEvent[]): string[] {
  const assigned: string[] = [];
  for (const e of events) {
    if (e.kind !== 'session_phase' || e.payload.phase !== 'session_id_assigned') continue;
    if (typeof e.payload.sessionId === 'string') assigned.push(e.payload.sessionId);
  }
  const ordered = [...assigned.reverse(), traceSessionId];
  return [...new Set(ordered)].filter(isSafeLedgerSessionId);
}

function safeJournalExists(sessionId: string): boolean {
  try {
    return journalExists(sessionId);
  } catch {
    return false;
  }
}

/**
 * Contract: indent every line under the tool row, strip terminal escapes and
 * control bytes, and cap at `maxLines` (0 = no cap) with a note naming how
 * many lines were hidden and the flag that shows them.
 */
export function renderResultBlock(text: string, maxLines: number, opts: { isError?: boolean; subagentId?: string } = {}): string {
  const clean = stripEscapeSequences(text).replace(/\r\n?/g, '\n').replace(CONTROL_RE, ' ');
  const lines = clean.length === 0 ? ['(empty result)'] : clean.replace(/\n$/, '').split('\n');
  const shown = maxLines > 0 && lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  const out = shown.map((l) => `${RESULT_INDENT}${l}`);
  const tags: string[] = [];
  if (opts.isError) tags.push('error result');
  if (opts.subagentId) tags.push(`from subagent journal ${opts.subagentId}`);
  if (shown.length < lines.length) {
    tags.push(`${lines.length - shown.length} more line(s) hidden; --results-lines 0 shows all`);
  }
  if (tags.length > 0) out.push(`${RESULT_INDENT}… ${tags.join(' · ')}`);
  return out.join('\n');
}

function lookupAcross(sessionIds: readonly string[], toolUseId: string): ReturnType<typeof findToolResult> {
  for (const id of sessionIds) {
    try {
      const found = findToolResult(id, toolUseId);
      if (found !== null) return found;
    } catch {
      // Unreadable journal: try the next candidate, then report not-found.
    }
  }
  return null;
}

/**
 * Build the per-call result renderer for a loaded trace. When no candidate
 * session has a journal, `resultFor` prints nothing and `note` says so once,
 * rather than repeating "not found" under every row.
 */
export function buildTraceResults(
  traceSessionId: string,
  events: readonly TraceEvent[],
  maxLines: number = DEFAULT_RESULT_LINES,
): TraceResultsContext {
  const candidates = journalSessionCandidates(traceSessionId, events);
  const withJournal = candidates.filter(safeJournalExists);
  if (withJournal.length === 0) {
    const tried = candidates.length > 0 ? candidates.join(', ') : traceSessionId;
    return {
      resultFor: () => null,
      note: `Results  no message journal for session ${tried} (journal disabled, or the session predates it)`,
    };
  }
  return {
    note: `Results  journal ${withJournal.join(', ')}${maxLines > 0 ? ` · first ${maxLines} lines per result` : ''}`,
    resultFor: (toolUseId) => {
      const found = lookupAcross(withJournal, toolUseId);
      if (found === null) return `${RESULT_INDENT}(result not found in the journal)`;
      return renderResultBlock(toolResultToText(found.block), maxLines, {
        isError: found.block.isError === true,
        ...(found.subagentId !== undefined ? { subagentId: found.subagentId } : {}),
      });
    },
  };
}

/** Append the result block under a rendered completed-tool_call row. */
export function withToolResult(
  line: string,
  event: TraceEvent,
  resultFor: ((toolUseId: string) => string | null) | undefined,
): string {
  if (resultFor === undefined || event.kind !== 'tool_call' || event.payload.phase !== 'completed') return line;
  const block = resultFor(event.payload.toolUseId);
  return block === null ? line : `${line}\n${block}`;
}
