/**
 * Adapts persisted ledger records into transcript items for rendering.
 *
 * Invariant: the ledger is a PROJECTION, not a transcript. As of Wave 1
 * (Step 1B), successful tool results ARE persisted (clipped to 400 chars),
 * thinking blocks are persisted, and richer event kinds (tool_activity,
 * rate_limit, progress, subagent_lifecycle, background_job, plan_mode) are
 * now present. Tool items replayed from older ledgers (pre-Wave 1) still
 * carry `outputUnavailable: true` — the `tool_result` record (new) provides
 * real output and sets `outputUnavailable: false`.
 *
 * This is deliberately separate from view-model.ts, which folds LIVE
 * OutputEvents. The two sources have genuinely different fidelity and
 * collapsing them would erase that distinction.
 */

import type { TranscriptItem, ToolCallItem } from './view-model.js';

/**
 * The subset of ledger record shape the web UI renders.
 *
 * Contract: `LedgerRecord` is `{ v: 1; ts: number } & LedgerPayload` — the
 * payload is FLATTENED onto the record, NOT nested under a `payload` key, and
 * `ts` is epoch milliseconds rather than an ISO string. Reading it as nested
 * silently yields an empty transcript, since every discriminant lookup misses.
 */
export interface LedgerRecordLike {
  v?: number;
  ts?: number;
  kind?: string;
  [key: string]: unknown;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * Convert one ledger record into a transcript item.
 *
 * Returns undefined for records with no visual representation (session meta,
 * the HMAC-signed remote-control records, the terminal `closed` marker).
 */
export function ledgerRecordToItem(
  record: LedgerRecordLike,
  /** Optional mutable index for matching `tool_result` back to an earlier `tool` item. */
  toolIndex?: Map<string, ToolCallItem>,
): TranscriptItem | undefined {
  const payload = record;
  if (typeof payload.kind !== 'string') return undefined;

  switch (payload.kind) {
    case 'user':
      return { kind: 'user', id: nextId('u'), text: str(payload['text']) ?? '' };

    case 'assistant':
      return { kind: 'assistant', id: nextId('a'), text: str(payload['text']) ?? '' };

    case 'thinking':
      return { kind: 'thinking', id: nextId('th'), text: str(payload['text']) ?? '' };

    case 'tool': {
      const input = str(payload['input']) ?? '';

      // Invariant: the CLI writes TWO `tool` records per call — a PLACEHOLDER
      // the instant the call starts streaming (arguments not yet parsed, so
      // `input` serializes to the lone ellipsis "…"), then a SUBSTANTIVE record
      // once the arguments are complete. The terminal surface repaints a single
      // line in place, so the placeholder is overwritten and never seen. An
      // append-only surface like this one renders both, which is why ~50% of
      // replayed transcript rows were content-free duplicates.
      //
      // Dropping the placeholder is lossless: in a 338-record sample the counts
      // were 170 placeholders against 150 substantive + 20 genuinely-empty
      // records — an exact 1:1 pairing, so every dropped row has a surviving
      // partner. Match the ellipsis EXACTLY and never on emptiness: an empty
      // `input` is a real no-arg call (browser_close, get_runtime_state) whose
      // only record this is, and treating it as a placeholder would erase it.
      if (input.trim() === '…') return undefined;

      // Contract: status 'ok' is INFERRED here. If the ledger also has a
      // corresponding `tool_result` record (Wave 1+), `ledgerToItems` will
      // patch the item's output in a second pass via `toolIndex`.
      const item: ToolCallItem = {
        kind: 'tool',
        id: nextId('t'),
        name: str(payload['toolName']) ?? 'tool',
        inputPreview: input,
        status: 'ok',
        outputUnavailable: true,  // may be cleared by a matching tool_result
      };
      // Register in the index by a synthetic key (toolName+input) isn't
      // reliable since multiple calls share the same tool name. The ledger
      // `tool_result` carries `toolUseId`; we use that for exact matching.
      // Pre-Wave 1 ledgers have no `toolUseId` on `tool` records, so the
      // index is best-effort.
      if (toolIndex && str(payload['toolUseId'])) {
        toolIndex.set(str(payload['toolUseId'])!, item);
      }
      return item;
    }

    case 'tool_result': {
      // Wave 1+: a successful tool result was persisted. Find the matching
      // tool item in the index and update it with the real output.
      const toolUseId = str(payload['toolUseId']);
      const content = str(payload['content']) ?? '';
      const durationMs = num(payload['durationMs']);
      if (toolIndex && toolUseId) {
        const existing = toolIndex.get(toolUseId);
        if (existing) {
          existing.output = content;
          existing.outputUnavailable = false;
          if (durationMs !== undefined) existing.durationMs = durationMs;
          return undefined; // no new item — we patched in place
        }
      }
      // No matching tool item found (pre-Wave 1 ledger without toolUseId on the
      // tool record, or out-of-order replay). Render as a standalone notice.
      return {
        kind: 'notice',
        id: nextId('n'),
        text: `tool result: ${content.slice(0, 80)}`,
      };
    }

    case 'tool_error': {
      // Contract: a `tool_error` record carries `content` but NO `toolName` —
      // the failing tool's identity is simply not in the ledger. Rendering the
      // bare fallback name against an empty preview produced a red row reading
      // only "tool", with the one useful string (the error itself) buried in a
      // collapsed panel. Promote the error's first line into the preview so the
      // row is self-describing at a glance; the full text stays in `output`.
      const content = str(payload['content']) ?? '';
      const firstLine = content.split('\n', 1)[0] ?? '';
      return {
        kind: 'tool',
        id: nextId('t'),
        name: str(payload['toolName']) ?? 'error',
        inputPreview: firstLine,
        status: 'error',
        output: content,
      };
    }

    case 'error':
      return { kind: 'error', id: nextId('e'), message: str(payload['message']) ?? 'error' };

    case 'done': {
      const cost = payload['costUsd'];
      const ms = payload['durationMs'];
      const bits: string[] = [];
      if (typeof cost === 'number') bits.push(`$${cost.toFixed(4)}`);
      if (typeof ms === 'number') bits.push(`${(ms / 1000).toFixed(1)}s`);
      // Token breakdown (Wave 1)
      const inputTok = num(payload['inputTokens']);
      const outputTok = num(payload['outputTokens']);
      const cacheRead = num(payload['cacheReadTokens']);
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
      const count = num(payload['activeCount']) ?? 0;
      if (count === 0) return { kind: 'notice', id: nextId('n'), text: 'tool wave complete' };
      const plural = count === 1 ? 'tool' : 'tools';
      return { kind: 'notice', id: nextId('n'), text: `Running ${count} ${plural} in parallel` };
    }

    case 'rate_limit': {
      const retryMs = num(payload['retryAfterMs']);
      const suffix = retryMs !== undefined ? ` (retrying in ${Math.ceil(retryMs / 1000)}s)` : '';
      return { kind: 'notice', id: nextId('n'), text: `Rate limited${suffix}` };
    }

    case 'progress':
      return { kind: 'notice', id: nextId('n'), text: str(payload['message']) ?? 'progress' };

    case 'subagent_lifecycle': {
      const subId = str(payload['subagentId']) ?? 'subagent';
      const status = str(payload['status']) ?? 'unknown';
      const agentType = str(payload['agentType']);
      const label = agentType ? `${agentType} (${subId.slice(0, 8)})` : subId.slice(0, 12);
      return {
        kind: 'subagent' as const,
        id: nextId('sa'),
        subagentId: subId,
        status,
        label,
        model: str(payload['model']),
        durationMs: num(payload['durationMs']),
        promptHead: str(payload['promptHead']),
      };
    }

    case 'background_job': {
      const jid = str(payload['jobId']) ?? 'job';
      const status = str(payload['status']) ?? 'unknown';
      const label = str(payload['label']) ?? jid.slice(0, 12);
      return { kind: 'bg_job' as const, id: nextId('bj'), jobId: jid, status, label };
    }

    case 'plan_mode': {
      const mode = str(payload['mode']) ?? 'default';
      return { kind: 'notice', id: nextId('n'), text: `Switched to ${mode} mode` };
    }

    default:
      return undefined;
  }
}

/**
 * Convert a list of ledger records into transcript items, correlating
 * `tool_result` records with their preceding `tool` records via toolUseId.
 */
export function ledgerToItems(records: LedgerRecordLike[]): TranscriptItem[] {
  const toolIndex = new Map<string, ToolCallItem>();
  const items: TranscriptItem[] = [];
  for (const rec of records) {
    const item = ledgerRecordToItem(rec, toolIndex);
    if (item) items.push(item);
  }
  return items;
}

/** Running cost/duration totals derived from `done` records. */
export interface SessionTotals {
  costUsd: number;
  durationMs: number;
  turns: number;
  /** Token counts from `done` records (Wave 1+). */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export function accumulateTotals(totals: SessionTotals, record: LedgerRecordLike): SessionTotals {
  const payload = record;
  if (payload.kind !== 'done') return totals;
  const cost = payload['costUsd'];
  const ms = payload['durationMs'];
  const inputTok = payload['inputTokens'];
  const outputTok = payload['outputTokens'];
  const cacheRead = payload['cacheReadTokens'];
  return {
    costUsd: totals.costUsd + (typeof cost === 'number' ? cost : 0),
    durationMs: totals.durationMs + (typeof ms === 'number' ? ms : 0),
    turns: totals.turns + 1,
    inputTokens: (totals.inputTokens ?? 0) + (typeof inputTok === 'number' ? inputTok : 0),
    outputTokens: (totals.outputTokens ?? 0) + (typeof outputTok === 'number' ? outputTok : 0),
    cacheReadTokens: (totals.cacheReadTokens ?? 0) + (typeof cacheRead === 'number' ? cacheRead : 0),
  };
}
