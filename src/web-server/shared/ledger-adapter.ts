/**
 * Adapts persisted ledger records into typed transcript items for rendering.
 *
 * This is the SINGLE SOURCE OF TRUTH for the ledger-to-transcript projection.
 * The React dashboard (dashboard/src/lib/ledger-adapter.ts) re-exports from
 * here so a schema change is applied in exactly one place.
 *
 * Invariant: the ledger is a PROJECTION, not a transcript. As of Wave 1, successful
 * tool results ARE persisted (clipped to 400 chars), thinking blocks are persisted,
 * and richer event kinds (tool_activity, rate_limit, progress, subagent_lifecycle,
 * background_job, plan_mode) are present. Tool items replayed from older ledgers
 * (pre-Wave 1) still carry `outputUnavailable: true` — the `tool_result` record
 * (Wave 1+) provides real output and sets `outputUnavailable: false`.
 *
 * SSE frames from the stream have shape `{ record: LedgerRecordLike, replay: boolean }`.
 * `replay: true` means the record comes from the historical ledger tail;
 * `replay: false` means it arrived live during this stream session.
 *
 * @module web-server/shared/ledger-adapter
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
      /** SubagentId of the dispatching agent, for tree-building. */
      parentId?: string;
      status: string;
      label: string;
      model?: string;
      /** Resolved agent type (e.g. "research", "composer [1/3]"). */
      agentType?: string;
      durationMs?: number;
      /** Total cost in USD from the terminal lifecycle event. */
      totalCostUsd?: number;
      promptHead?: string;
    }
  | { kind: 'bg_job'; id: string; jobId: string; status: string; label: string };

export type ToolCallItem = Extract<TranscriptItem, { kind: 'tool' }>;
export type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>;

export interface SessionTotals {
  costUsd: number;
  durationMs: number;
  turns: number;
  /** Token counts from `done` records (Wave 1+). */
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

/**
 * Index of tool items by toolUseId, for patching when tool_result arrives.
 * The caller is responsible for passing the same index across calls in a
 * streaming session so correlations work across frames.
 */
export type ToolIndex = Map<string, ToolCallItem>;

/**
 * Index of subagent items by subagentId, for deduplicating lifecycle events.
 * Later `subagent_lifecycle` records (e.g. `succeeded` after `started`) patch
 * the existing card rather than appending a new one.
 */
export type SubagentIndex = Map<string, SubagentItem>;

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
// Core converter
// ---------------------------------------------------------------------------

/**
 * Convert one ledger record into a transcript item, optionally patching an
 * existing tool or subagent item when the record is a `tool_result` or a
 * subsequent `subagent_lifecycle` event.
 *
 * Returns `undefined` for records with no visual representation (session meta,
 * remote-control HMAC records, terminal `closed` marker).
 *
 * Contract: when indexes are provided:
 *   - A `tool` record with a `toolUseId` is stored in `toolIndex` immediately.
 *   - A `tool_result` record that finds its match MUTATES the existing item in
 *     place and returns `undefined` (no new item is added). The caller owns the
 *     items array and must trigger a re-render after.
 *   - If no match exists for a `tool_result`, a standalone notice is emitted.
 *   - A `subagent_lifecycle` record that finds its match in `subagentIndex` MUTATES
 *     the existing card (status, durationMs) and returns `undefined`.
 */
export function ledgerRecordToItem(
  record: LedgerRecordLike,
  toolIndex?: ToolIndex,
  subagentIndex?: SubagentIndex,
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
      const item: ToolCallItem = {
        kind: 'tool',
        id: nextId('t'),
        name: str(record['toolName']) ?? 'tool',
        toolUseId,
        inputPreview: input,
        // Contract: status 'ok' is inferred. The ledger records that a tool
        // started; a corresponding tool_result arrives separately (Wave 1+).
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
      // Wave 1+: a successful tool result was persisted. Find the matching
      // tool item in the index and update it with the real output.
      const toolUseId = str(record['toolUseId']);
      const content = str(record['content']) ?? str(record['output']) ?? '';
      const durationMs = num(record['durationMs']);
      const diff = str(record['diff']);

      if (toolIndex !== undefined && toolUseId !== undefined) {
        const existing = toolIndex.get(toolUseId);
        if (existing !== undefined) {
          existing.output = content;
          existing.outputUnavailable = false;
          existing.status = 'ok';
          if (durationMs !== undefined) existing.durationMs = durationMs;
          if (diff !== undefined) existing.diff = diff;
          // Mutation triggers: callers must force a re-render. Return undefined
          // so no duplicate item is added.
          return undefined;
        }
      }

      // No match — render as a standalone notice (pre-Wave 1 ledger or
      // out-of-order replay without a toolUseId on the preceding tool record).
      return {
        kind: 'notice',
        id: nextId('n'),
        text: `tool result: ${content.slice(0, 80)}`,
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
      // Token breakdown (Wave 1+)
      const inputTok = num(record['inputTokens']);
      const outputTok = num(record['outputTokens']);
      const cacheRead = num(record['cacheReadTokens']);
      if (inputTok !== undefined || outputTok !== undefined) {
        const parts: string[] = [];
        if (inputTok !== undefined) parts.push(`${inputTok}in`);
        if (outputTok !== undefined) parts.push(`${outputTok}out`);
        if (cacheRead !== undefined) parts.push(`${cacheRead}cache`);
        bits.push(parts.join('/'));
      }
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

    case 'tool_activity': {
      const count = num(record['activeCount']) ?? 0;
      if (count === 0) return { kind: 'notice', id: nextId('n'), text: 'tool wave complete' };
      const plural = count === 1 ? 'tool' : 'tools';
      return { kind: 'notice', id: nextId('n'), text: `Running ${count} ${plural} in parallel` };
    }

    case 'rate_limit': {
      const retryMs = num(record['retryAfterMs']);
      const suffix = retryMs !== undefined ? ` (retrying in ${Math.ceil(retryMs / 1000)}s)` : '';
      return { kind: 'notice', id: nextId('n'), text: `Rate limited${suffix}` };
    }

    case 'progress':
      return { kind: 'notice', id: nextId('n'), text: str(record['message']) ?? 'progress' };

    case 'subagent_lifecycle': {
      const subId = str(record['subagentId']) ?? 'subagent';
      const status = str(record['status']) ?? 'unknown';
      const agentType = str(record['agentType']);
      const label = agentType ? `${agentType} (${subId.slice(0, 8)})` : subId.slice(0, 12);

      // Deduplicate: if we've already emitted a card for this subagentId, patch
      // the existing item in place (status and durationMs come from later records)
      // rather than appending a new card.
      if (subagentIndex !== undefined) {
        const existing = subagentIndex.get(subId);
        if (existing !== undefined) {
          existing.status = status;
          const dur = num(record['durationMs']);
          if (dur !== undefined) existing.durationMs = dur;
          const cost = num(record['totalCostUsd']);
          if (cost !== undefined) existing.totalCostUsd = cost;
          return undefined; // patched in place — no new item
        }
      }

      const item: SubagentItem = {
        kind: 'subagent',
        id: nextId('sa'),
        subagentId: subId,
        parentId: str(record['parentId']),
        status,
        label,
        model: str(record['model']),
        agentType: str(record['agentType']),
        durationMs: num(record['durationMs']),
        totalCostUsd: num(record['totalCostUsd']),
        promptHead: str(record['promptHead']),
      };

      subagentIndex?.set(subId, item);
      return item;
    }

    case 'background_job': {
      const jobId = str(record['jobId']) ?? 'job';
      const status = str(record['status']) ?? 'unknown';
      const label = str(record['label']) ?? jobId.slice(0, 12);
      return { kind: 'bg_job', id: nextId('bj'), jobId, status, label };
    }

    case 'plan_mode': {
      const mode = str(record['mode']) ?? 'default';
      return { kind: 'notice', id: nextId('n'), text: `Switched to ${mode} mode` };
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

/**
 * Convert a list of ledger records into transcript items, correlating
 * `tool_result` records with their preceding `tool` records via toolUseId,
 * and deduplicating `subagent_lifecycle` records by subagentId.
 */
export function ledgerToItems(records: LedgerRecordLike[]): TranscriptItem[] {
  const toolIndex: ToolIndex = new Map();
  const subagentIndex: SubagentIndex = new Map();
  const items: TranscriptItem[] = [];
  for (const record of records) {
    const item = ledgerRecordToItem(record, toolIndex, subagentIndex);
    if (item !== undefined) {
      items.push(item);
    }
  }
  return items;
}
