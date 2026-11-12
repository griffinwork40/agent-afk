/**
 * Tool handler for read_journal — full conversation content from session journals.
 *
 * Peer to `witness.ts` (trace metadata). This handler exposes the data
 * that `read_witness` explicitly does NOT carry: complete tool arguments,
 * full tool output, and user/assistant message text.
 *
 * Two modes:
 *   - tool_use_id lookup: single tool result via `findToolResultAsync` (async, non-blocking)
 *   - conversation messages: fold + hydrate via `loadJournalMessages` (sync, same pattern
 *     as facet derivation)
 *
 * @module agent/tools/handlers/journal
 */

import { readdir, stat } from 'node:fs/promises';
import type { ToolHandler } from '../types.js';
import { findToolResultAsync, journalExistsAsync } from '../../journal/reader.async.js';
import { loadJournalMessages } from '../../journal/reader.js';
import { resolveSessionByName } from '../../trace/session-name-resolver.js';
import { getSessionsDir, isSafeLedgerSessionId } from '../../../paths.js';
import { errorMessage, isErrnoCode } from '../../../utils/errors.js';
import type { JournalMessage, JournalResultPart } from '../../journal/types.js';

// ---------------------------------------------------------------------------
// Inline tool-result text renderer
// ---------------------------------------------------------------------------
// Contract: `toolResultToText` lives in `web-server/` (Surface layer) and
// cannot be imported from `agent/` (Core). This is a minimal inline
// equivalent that avoids the layer violation.

function resultPartToText(part: JournalResultPart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'text_ref':
      return `${part.preview}\n[… spilled text not hydrated: ${part.ref.bytes} bytes]`;
    case 'image':
      return '[image]';
    case 'document':
      return part.title ? `[document: "${part.title}"]` : '[document]';
  }
}

function resultBlockToText(content: readonly JournalResultPart[]): string {
  return content.map(resultPartToText).join('\n');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on rendered tool result text (bytes). */
const MAX_RESULT_BYTES = 65_536; // 64 KB

/** Default message limit. */
const DEFAULT_LIMIT = 20;

/** Hard ceiling on messages returned. */
const MAX_LIMIT = 100;

/** Cap on text preview for user/assistant message content. */
const TEXT_PREVIEW_CAP = 2000;

/** Cap on tool input JSON preview. */
const INPUT_PREVIEW_CAP = 500;

/** Cap on tool result text preview in conversation mode. */
const RESULT_PREVIEW_CAP = 500;

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

/**
 * Scan state/sessions/ for directories containing `journal.jsonl`,
 * sorted by mtime descending. Returns the session ID of the newest one,
 * or null when none exist.
 *
 * Uses the sessions dir (keyed by SDK session ID) rather than the witness
 * root (keyed by trace label UUID) so the resolved ID is always valid for
 * `getSessionJournalPath(id)`.
 */
async function resolveLatestJournalSession(): Promise<string | null> {
  const sessionsDir = getSessionsDir();
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return null;
    throw err;
  }

  let bestId: string | null = null;
  let bestMtime = 0;
  for (const name of names) {
    if (!isSafeLedgerSessionId(name)) continue;
    try {
      const journalPath = `${sessionsDir}/${name}/journal.jsonl`;
      const st = await stat(journalPath);
      if (st.isFile() && st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestId = name;
      }
    } catch {
      // no journal in this dir — skip
    }
  }
  return bestId;
}

/**
 * Resolve a session identifier to a validated session ID with a journal.
 * Tries: direct ID, session-name lookup. Returns null when unresolvable.
 */
async function resolveSessionId(
  raw: string | undefined,
): Promise<{ sessionId: string } | { error: string }> {
  if (!raw || raw === 'latest') {
    const latest = await resolveLatestJournalSession();
    if (!latest) return { error: 'No sessions found.' };
    return { sessionId: latest };
  }

  if (isSafeLedgerSessionId(raw) && (await journalExistsAsync(raw))) {
    return { sessionId: raw };
  }

  // Try human-name / session-name resolution.
  try {
    const resolved = resolveSessionByName(raw);
    if (resolved && isSafeLedgerSessionId(resolved.sessionId)) {
      if (await journalExistsAsync(resolved.sessionId)) {
        return { sessionId: resolved.sessionId };
      }
    }
  } catch { /* fs error during name scan — fall through */ }

  // Last attempt: the raw value might be valid but have no journal.
  if (isSafeLedgerSessionId(raw)) {
    return { error: `No message journal found for session "${raw}". The session may predate the journal or ran with journaling disabled.` };
  }

  return { error: `Invalid or unresolvable session identifier: "${raw}".` };
}

// ---------------------------------------------------------------------------
// Tool-result lookup mode
// ---------------------------------------------------------------------------

async function lookupToolResult(
  sessionId: string,
  toolUseId: string,
): Promise<{ content: string; isError?: true }> {
  const found = await findToolResultAsync(sessionId, toolUseId);
  if (!found) {
    return {
      content: JSON.stringify({
        sessionId,
        tool_use_id: toolUseId,
        result: null,
        note: 'Tool result not found in the journal. The tool call may not exist, may still be in progress, or the journal may be absent.',
      }),
    };
  }

  let text = resultBlockToText(found.block.content);
  let truncated = false;
  if (Buffer.byteLength(text, 'utf-8') > MAX_RESULT_BYTES) {
    // Truncate to byte cap, then trim to last full line.
    const buf = Buffer.from(text, 'utf-8').subarray(0, MAX_RESULT_BYTES);
    text = buf.toString('utf-8');
    // Buffer.subarray can split a multi-byte UTF-8 sequence: Node replaces the
    // incomplete tail with U+FFFD (\uFFFD). Strip any such replacement characters
    // from the end before appending the truncation notice.
    text = text.replace(/\uFFFD+$/, '');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline > 0) text = text.slice(0, lastNewline);
    text += `\n… [truncated at ${Math.round(MAX_RESULT_BYTES / 1024)} KB]`;
    truncated = true;
  }

  return {
    content: JSON.stringify({
      sessionId,
      tool_use_id: toolUseId,
      is_error: found.block.isError === true,
      ...(found.subagentId !== undefined ? { subagent_id: found.subagentId } : {}),
      truncated,
      result: text,
    }),
  };
}

// ---------------------------------------------------------------------------
// Conversation messages mode
// ---------------------------------------------------------------------------

/** Recognized block-type filter values. */
const VALID_KINDS = new Set(['user', 'assistant', 'tool_use', 'tool_result']);

interface MessageSummary {
  role: string;
  blocks: BlockSummary[];
}

type BlockSummary =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input_preview: string }
  | { type: 'tool_result'; tool_use_id: string; is_error: boolean; text_preview: string }
  | { type: 'image'; media_type?: string }
  | { type: 'other'; block_type: string };

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function summarizeBlock(block: Record<string, unknown>): BlockSummary {
  const type = block['type'] as string | undefined;

  if (type === 'text' && typeof block['text'] === 'string') {
    return { type: 'text', text: cap(block['text'] as string, TEXT_PREVIEW_CAP) };
  }

  if (type === 'tool_use') {
    const id = (block['id'] as string) ?? '';
    const name = (block['name'] as string) ?? '';
    let inputPreview = '';
    try {
      inputPreview = cap(JSON.stringify(block['input']), INPUT_PREVIEW_CAP);
    } catch { /* non-serializable input */ }
    return { type: 'tool_use', id, name, input_preview: inputPreview };
  }

  if (type === 'tool_result') {
    const toolUseId = (block['toolUseId'] as string) ?? '';
    const isError = block['isError'] === true;
    let preview = '';
    try {
      // Contract: toolResultToText expects a typed block; we have a raw journal block.
      // Use content array text parts directly for the preview.
      const content = block['content'];
      if (Array.isArray(content)) {
        const texts = content
          .filter((p: Record<string, unknown>) => p['type'] === 'text' && typeof p['text'] === 'string')
          .map((p: Record<string, unknown>) => p['text'] as string);
        preview = cap(texts.join('\n'), RESULT_PREVIEW_CAP);
      }
    } catch { /* malformed content */ }
    return { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, text_preview: preview };
  }

  if (type === 'image') {
    const source = block['source'] as Record<string, unknown> | undefined;
    return { type: 'image', media_type: source?.['media_type'] as string | undefined };
  }

  return { type: 'other', block_type: type ?? 'unknown' };
}

function blockKind(block: Record<string, unknown>): string {
  const type = block['type'] as string | undefined;
  return type ?? 'unknown';
}

function summarizeMessage(msg: JournalMessage): MessageSummary {
  return {
    role: msg.role,
    blocks: msg.content.map((b) => summarizeBlock(b as unknown as Record<string, unknown>)),
  };
}

function messageMatchesKinds(msg: JournalMessage, kinds: Set<string>): boolean {
  // A message matches if its role or any block type is in the kinds set.
  if (kinds.has(msg.role)) return true;
  return msg.content.some((b) => kinds.has(blockKind(b as unknown as Record<string, unknown>)));
}

function loadConversation(
  sessionId: string,
  kinds: Set<string> | undefined,
  limit: number,
): { content: string } {
  const messages = loadJournalMessages(sessionId);
  if (!messages || messages.length === 0) {
    return {
      content: JSON.stringify({
        sessionId,
        messages: [],
        total: 0,
        returned: 0,
        note: 'Journal is empty, absent, or disabled for this session.',
      }),
    };
  }

  let filtered: JournalMessage[];
  if (kinds) {
    filtered = messages.filter((m) => messageMatchesKinds(m, kinds));
  } else {
    filtered = [...messages];
  }

  const total = filtered.length;
  // Take the N most recent.
  const sliced = filtered.slice(-limit);
  const summaries = sliced.map(summarizeMessage);

  return {
    content: JSON.stringify({
      sessionId,
      messages: summaries,
      total,
      returned: summaries.length,
      ...(total > summaries.length ? { note: `Showing last ${summaries.length} of ${total} matching messages.` } : {}),
    }),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function clampLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(raw)));
}

export const readJournalHandler: ToolHandler = async (input) => {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!obj) {
    return { content: 'Invalid input: expected object', isError: true };
  }

  const sessionRaw = typeof obj['session'] === 'string' ? obj['session'] : undefined;
  const resolved = await resolveSessionId(sessionRaw);
  if ('error' in resolved) {
    return { content: `read_journal failed: ${resolved.error}`, isError: true };
  }
  const { sessionId } = resolved;

  // Mode A: single tool result lookup.
  const toolUseId = typeof obj['tool_use_id'] === 'string' ? obj['tool_use_id'] : undefined;
  if (toolUseId && toolUseId.length > 512) {
    return { content: 'read_journal failed: tool_use_id exceeds maximum length (512).', isError: true };
  }
  if (toolUseId) {
    try {
      return await lookupToolResult(sessionId, toolUseId);
    } catch (err) {
      return { content: `read_journal failed: ${errorMessage(err)}`, isError: true };
    }
  }

  // Mode B: conversation messages.
  try {
    const rawKinds = Array.isArray(obj['kinds'])
      ? (obj['kinds'] as unknown[]).filter((x): x is string => typeof x === 'string' && VALID_KINDS.has(x))
      : undefined;
    const kinds = rawKinds && rawKinds.length > 0 ? new Set(rawKinds) : undefined;
    const limit = clampLimit(obj['limit']);
    return loadConversation(sessionId, kinds, limit);
  } catch (err) {
    return { content: `read_journal failed: ${errorMessage(err)}`, isError: true };
  }
};
