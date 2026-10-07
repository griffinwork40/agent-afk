/**
 * `GET /api/sessions/:id/tool-results/:toolUseId` — full tool output, lazily.
 *
 * The session ledger (and therefore the SSE stream) carries only a clipped
 * preview of each tool result so live tailers stay cheap. The message journal
 * holds the full content; this route serves ONE result on demand when the
 * user expands a tool row. Full results are never inlined into the ledger or
 * the SSE stream.
 *
 * Contract: dispatched from `server.ts` after the bearer-token check. Read
 * only, and deliberately NOT ownership-gated: the ledger of a foreign
 * (attach-only) session is already streamable, and this is the same
 * session's data at higher fidelity.
 *
 * Invariant: neither id is ever turned into a path here. The session id must
 * pass `isSafeLedgerSessionId` (via `requireValidSessionId`) and the tool-use
 * id must match {@link TOOL_USE_ID_PATTERN}; the journal reader derives every
 * path itself from the validated session id, so a request cannot name an
 * arbitrary file.
 *
 * Implementation note: the lookup uses {@link findToolResultAsync} so the
 * journal read is fully non-blocking (readline over a ReadStream), and the 404
 * branch uses {@link journalExistsAsync} (fs.promises.stat().isFile()) so the
 * entire handler is non-blocking. The sync `findToolResult`/`journalExists`
 * from reader.ts are retained for `afk trace show --results`, which is a
 * one-shot CLI where synchronous reads are acceptable.
 *
 * @module web-server/routes.tool-results
 */

import type { ServerResponse } from 'node:http';
import { findToolResultAsync, journalExistsAsync } from '../agent/journal/index.js';
import { requireValidSessionId, sendJson } from './routes.js';
import { toolResultToText } from './tool-result-text.js';
import { errorMessage } from '../utils/errors.js';

/**
 * Provider tool-call ids: Anthropic `toolu_…`, OpenAI `call_…`, plus the
 * separators some gateways add. No `/`, no `..`-only values of concern since
 * the id is matched against record content, never joined into a path.
 */
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;

/**
 * Cap on the text returned in one response. A multi-megabyte `cat` result is
 * still served (truncated, flagged) rather than stalling the browser.
 */
export const MAX_TOOL_RESULT_CHARS = 1_000_000;

/** Wire shape. Mirrored in dashboard/src/types/api.ts. */
export interface ToolResultResponse {
  toolUseId: string;
  isError: boolean;
  /** Set when the result was found in a subagent's journal. */
  subagentId?: string;
  /** Display text: text parts verbatim, binary parts as placeholders. */
  text: string;
  /** Length of the full display text before the response cap. */
  totalChars: number;
  truncated: boolean;
}

export function isSafeToolUseId(id: string): boolean {
  return TOOL_USE_ID_PATTERN.test(id);
}

export async function handleGetToolResult(res: ServerResponse, sessionId: string, toolUseId: string): Promise<void> {
  if (!requireValidSessionId(res, sessionId)) return;
  if (!isSafeToolUseId(toolUseId)) {
    sendJson(res, 400, {
      error: 'bad_tool_use_id',
      message: 'tool use id must be 1-256 chars of [A-Za-z0-9_.:-]',
    });
    return;
  }

  let found: Awaited<ReturnType<typeof findToolResultAsync>>;
  try {
    found = await findToolResultAsync(sessionId, toolUseId);
  } catch (error) {
    sendJson(res, 500, { error: 'journal_read_failed', message: errorMessage(error) });
    return;
  }

  if (found === null) {
    // journalExistsAsync uses fs.promises.stat().isFile() — no statSync, fully async.
    const hasJournal = await journalExistsAsync(sessionId);
    sendJson(res, 404, {
      error: hasJournal ? 'tool_result_not_found' : 'journal_not_found',
      message: hasJournal
        ? `no tool result ${toolUseId} in the journal for session ${sessionId}`
        : `session ${sessionId} has no message journal (journal disabled, or the session predates it)`,
    });
    return;
  }

  const full = toolResultToText(found.block);
  const truncated = full.length > MAX_TOOL_RESULT_CHARS;
  const body: ToolResultResponse = {
    toolUseId,
    isError: found.block.isError === true,
    ...(found.subagentId !== undefined ? { subagentId: found.subagentId } : {}),
    text: truncated ? full.slice(0, MAX_TOOL_RESULT_CHARS) : full,
    totalChars: full.length,
    truncated,
  };
  sendJson(res, 200, body);
}
