/**
 * Adapts persisted ledger records into typed transcript items for rendering.
 *
 * Invariant: the ledger is a PROJECTION, not a transcript. Successful tool
 * results are never persisted (only failures are), assistant text is capped at
 * 8000 chars, and tool inputs are truncated at 400 chars. A `tool` record
 * replayed from disk proves the tool RAN but cannot supply output — those
 * items are marked `outputUnavailable` so the UI can say "result not available
 * after refresh" rather than rendering blank space that reads as "no output".
 *
 * SSE frames from the stream have shape `{ record: LedgerRecordLike, replay: boolean }`.
 * `replay: true` means the record comes from the historical ledger tail;
 * `replay: false` means it arrived live during this stream session.
 *
 * Port of src/web-server/frontend/ledger-adapter.ts with:
 *   - toolUseId indexed for tool_result correlation
 *   - SessionTotals extended with optional token fields
 *   - ledgerToItems() for batch replay
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      toolUseId?: string;
      inputPreview: string;
      status: 'running' | 'ok' | 'error';
      output?: string;
      outputUnavailable?: boolean;
      diff?: string;
      durationMs?: number;
    }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'notice'; id: string; text: string }
  | {
      kind: 'subagent';
      id: string;
      subagentId: string;
      status: string;
      label: string;
      model?: string;
      durationMs?: number;
      promptHead?: string;
    }
  | { kind: 'bg_job'; id: string; jobId: string; status: string; label: string };

export interface SessionTotals {
  costUsd: number;
  durationMs: number;
  turns: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/**
 * The flattened shape of a persisted ledger record.
 *
 * Contract: `LedgerRecord` is `{ v: 1; ts: number } & LedgerPayload` — the
 * payload is FLATTENED onto the record object, NOT nested under a `payload`
 * key. `ts` is epoch milliseconds. Reading it as nested silently yields an
 * empty transcript because every discriminant lookup misses.
 */
export interface LedgerRecordLike {
  v?: number;
  ts?: number;
  kind?: string;
  [key: string]: unknown;
}

/** Shape of each SSE frame payload from /api/sessions/:id/stream. */
export interface SseStreamFrame {
  record: LedgerRecordLike;
  replay: boolean;
}

// ---------------------------------------------------------------------------
// ID counter — monotonic, reset between sessions
// ---------------------------------------------------------------------------

let counter = 0;

/** Reset to 0 between session switches to prevent cross-session id collisions. */
export function resetIdCounter(): void {
  counter = 0;
}

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Tool index — correlates tool_result records back to their tool items
// ---------------------------------------------------------------------------

/**
 * Index of tool items by toolUseId, for patching when tool_result arrives.
 * The caller is responsible for passing the same index across calls in a
 * streaming session so correlations work across frames.
 */
export type ToolIndex = Map<string, Extract<TranscriptItem, { kind: 'tool' }>>;

// ---------------------------------------------------------------------------
// Core converter
// ---------------------------------------------------------------------------

/**
 * Convert one ledger record into a transcript item, optionally patching an
 * existing tool item when the record is a `tool_result`.
 *
 * Returns `undefined` for records with no visual representation (session meta,
 * remote-control HMAC records, terminal `closed` marker).
 *
 * Contract: when `toolIndex` is provided:
 *   - A `tool` record with a `toolUseId` is stored in the index immediately.
 *   - A `tool_result` record that finds its match in the index MUTATES the
 *     existing item in place and returns `undefined` (no new item is added).
 *     The caller owns the items array and must trigger a re-render after.
 *   - If no match exists for a `tool_result`, a new item is created instead.
 */
export function ledgerRecordToItem(
  record: LedgerRecordLike,
  toolIndex?: ToolIndex,
): TranscriptItem | undefined {
  if (typeof record.kind !== 'string') return undefined;

  switch (record.kind) {
    case 'user':
      return { kind: 'user', id: nextId('u'), text: str(record['text']) ?? '' };

    case 'assistant':
      return { kind: 'assistant', id: nextId('a'), text: str(record['text']) ?? '' };

    case 'thinking':
      return { kind: 'thinking', id: nextId('th'), text: str(record['text']) ?? '' };

    case 'tool': {
      const input = str(record['input']) ?? '';

      // Invariant: the CLI writes two `tool` records per call — a PLACEHOLDER
      // (arguments not yet parsed, so `input` is the lone ellipsis "…") and a
      // SUBSTANTIVE record once arguments are complete. Drop the placeholder;
      // match the exact ellipsis, never on empty (empty input = real no-arg call).
      if (input.trim() === '…') return undefined;

      const toolUseId = str(record['toolUseId']);
      const item: Extract<TranscriptItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: nextId('t'),
        name: str(record['toolName']) ?? 'tool',
        toolUseId,
        inputPreview: input,
        // Contract: status 'ok' is inferred. The ledger records that a tool
        // started; a corresponding failure arrives as a separate `tool_error`.
        // Absence of output here is a gap in the record, not evidence that the
        // tool produced nothing — hence outputUnavailable.
        status: 'ok',
        outputUnavailable: true,
      };

      if (toolIndex !== undefined && toolUseId !== undefined) {
        toolIndex.set(toolUseId, item);
      }

      return item;
    }

    case 'tool_result': {
      const toolUseId = str(record['toolUseId']);
      const output = str(record['output']) ?? '';
      const durationMs = num(record['durationMs']);
      const diff = str(record['diff']);

      // Patch the matching tool item in place if we have it.
      if (toolIndex !== undefined && toolUseId !== undefined) {
        const existing = toolIndex.get(toolUseId);
        if (existing !== undefined) {
          existing.output = output;
          existing.outputUnavailable = false;
          existing.status = 'ok';
          if (durationMs !== undefined) existing.durationMs = durationMs;
          if (diff !== undefined) existing.diff = diff;
          // Mutation triggers: callers must force a re-render. Return undefined
          // so no duplicate item is added.
          return undefined;
        }
      }

      // No match — create a standalone result item.
      return {
        kind: 'tool',
        id: nextId('t'),
        name: str(record['toolName']) ?? 'tool',
        toolUseId,
        inputPreview: '',
        status: 'ok',
        output,
        outputUnavailable: false,
        durationMs,
        diff,
      };
    }

    case 'tool_error': {
      // Contract: a `tool_error` record carries `content` but may lack `toolName`.
      // Promote the error's first line into the inputPreview so the row is
      // self-describing at a glance without expanding.
      const content = str(record['content']) ?? '';
      const firstLine = content.split('\n', 1)[0] ?? '';
      return {
        kind: 'tool',
        id: nextId('t'),
        name: str(record['toolName']) ?? 'error',
        inputPreview: firstLine,
        status: 'error',
        output: content,
      };
    }

    case 'error':
      return { kind: 'error', id: nextId('e'), message: str(record['message']) ?? 'error' };

    case 'done': {
      const cost = record['costUsd'];
      const ms = record['durationMs'];
      const bits: string[] = [];
      if (typeof cost === 'number') bits.push(`$${cost.toFixed(4)}`);
      if (typeof ms === 'number') bits.push(`${(ms / 1000).toFixed(1)}s`);
      return {
        kind: 'notice',
        id: nextId('n'),
        text: bits.length ? `turn complete · ${bits.join(' · ')}` : 'turn complete',
      };
    }

    case 'paused':
      return { kind: 'notice', id: nextId('n'), text: 'paused — usage limit' };

    case 'resumed':
      return { kind: 'notice', id: nextId('n'), text: 'resumed' };

    case 'subagent_lifecycle': {
      const subagentId = str(record['subagentId']) ?? '';
      const status = str(record['status']) ?? 'started';
      const label = str(record['label']) ?? subagentId;
      const model = str(record['model']);
      const durationMs = num(record['durationMs']);
      const promptHead = str(record['promptHead']);
      return {
        kind: 'subagent',
        id: nextId('sa'),
        subagentId,
        status,
        label,
        model,
        durationMs,
        promptHead,
      };
    }

    case 'background_job': {
      const jobId = str(record['jobId']) ?? '';
      const status = str(record['status']) ?? 'started';
      const label = str(record['label']) ?? jobId;
      return { kind: 'bg_job', id: nextId('bj'), jobId, status, label };
    }

    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Totals accumulator
// ---------------------------------------------------------------------------

export function accumulateTotals(
  totals: SessionTotals,
  record: LedgerRecordLike,
): SessionTotals {
  if (record.kind !== 'done') return totals;
  const cost = record['costUsd'];
  const ms = record['durationMs'];
  const inputTok = record['inputTokens'];
  const outputTok = record['outputTokens'];
  const cacheRead = record['cacheReadTokens'];
  return {
    costUsd: totals.costUsd + (typeof cost === 'number' ? cost : 0),
    durationMs: totals.durationMs + (typeof ms === 'number' ? ms : 0),
    turns: totals.turns + 1,
    inputTokens: (totals.inputTokens ?? 0) + (typeof inputTok === 'number' ? inputTok : 0),
    outputTokens: (totals.outputTokens ?? 0) + (typeof outputTok === 'number' ? outputTok : 0),
    cacheReadTokens:
      (totals.cacheReadTokens ?? 0) + (typeof cacheRead === 'number' ? cacheRead : 0),
  };
}

// ---------------------------------------------------------------------------
// Batch conversion (for replay / initial load)
// ---------------------------------------------------------------------------

export function ledgerToItems(records: LedgerRecordLike[]): TranscriptItem[] {
  const toolIndex: ToolIndex = new Map();
  const items: TranscriptItem[] = [];
  for (const record of records) {
    const item = ledgerRecordToItem(record, toolIndex);
    if (item !== undefined) {
      items.push(item);
    } else if (record.kind === 'tool_result') {
      // tool_result mutated an existing item in the list — trigger a stable
      // reference update by replacing the mutated item in place.
      // (Items array already contains the mutated object; no push needed.)
    }
  }
  return items;
}
