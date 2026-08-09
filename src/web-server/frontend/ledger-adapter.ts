/**
 * Adapts persisted ledger records into transcript items for rendering.
 *
 * Invariant: the ledger is a PROJECTION, not a transcript. Successful tool
 * results are never written to it (only failures are), assistant text is
 * capped, and tool inputs are truncated. So a `tool` record replayed from disk
 * can prove that a tool RAN but can never supply its output. Those items are
 * marked `outputUnavailable` so the UI can say "result not available after
 * refresh" instead of rendering blank space that reads as "returned nothing".
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

/**
 * Convert one ledger record into a transcript item.
 *
 * Returns undefined for records with no visual representation (session meta,
 * the HMAC-signed remote-control records, the terminal `closed` marker).
 */
export function ledgerRecordToItem(record: LedgerRecordLike): TranscriptItem | undefined {
  const payload = record;
  if (typeof payload.kind !== 'string') return undefined;

  switch (payload.kind) {
    case 'user':
      return { kind: 'user', id: nextId('u'), text: str(payload['text']) ?? '' };

    case 'assistant':
      return { kind: 'assistant', id: nextId('a'), text: str(payload['text']) ?? '' };

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

      // Contract: status 'ok' is inferred, not observed. The ledger records
      // that a tool started; a corresponding failure would arrive as a separate
      // `tool_error`. Absence of output here is a gap in the record, never
      // evidence that the tool produced nothing — hence outputUnavailable.
      const item: ToolCallItem = {
        kind: 'tool',
        id: nextId('t'),
        name: str(payload['toolName']) ?? 'tool',
        inputPreview: input,
        status: 'ok',
        outputUnavailable: true,
      };
      return item;
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

    default:
      return undefined;
  }
}

/** Running cost/duration totals derived from `done` records. */
export interface SessionTotals {
  costUsd: number;
  durationMs: number;
  turns: number;
}

export function accumulateTotals(totals: SessionTotals, record: LedgerRecordLike): SessionTotals {
  const payload = record;
  if (payload.kind !== 'done') return totals;
  const cost = payload['costUsd'];
  const ms = payload['durationMs'];
  return {
    costUsd: totals.costUsd + (typeof cost === 'number' ? cost : 0),
    durationMs: totals.durationMs + (typeof ms === 'number' ? ms : 0),
    turns: totals.turns + 1,
  };
}
