/**
 * Combines the SSE stream with the ledger adapter to produce a typed
 * transcript for a given session.
 *
 * Invariant: resetting on sessionId change clears the id counter (via
 * resetIdCounter) so item ids from the old session never collide with the new.
 *
 * SSE frames from /api/sessions/:id/stream have shape:
 *   { record: LedgerRecordLike, replay: boolean }
 *
 * Both replay (historical) and live frames are processed identically here —
 * the distinction is available to callers via the raw `events` from
 * useSseStream if they need to e.g. visually separate replay from live.
 */

import { useEffect, useRef, useState } from 'react';
import { useSseStream } from '@/hooks/use-sse-stream';
import type { StreamStatus } from '@/hooks/use-sse-stream';
import {
  accumulateTotals,
  ledgerRecordToItem,
  resetIdCounter,
} from '@/lib/ledger-adapter';
import type { LedgerRecordLike, SessionTotals, ToolIndex, TranscriptItem } from '@/lib/ledger-adapter';

const EMPTY_TOTALS: SessionTotals = {
  costUsd: 0,
  durationMs: 0,
  turns: 0,
};

export interface UseTranscriptResult {
  items: TranscriptItem[];
  totals: SessionTotals;
  status: StreamStatus;
  error: string | null;
}

export function useTranscript(sessionId: string | null): UseTranscriptResult {
  const { events, status, error } = useSseStream(sessionId);

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [totals, setTotals] = useState<SessionTotals>(EMPTY_TOTALS);

  // Stable tool index across renders — keyed by toolUseId for correlation.
  // Reset when sessionId changes.
  const toolIndexRef = useRef<ToolIndex>(new Map());

  // Reset transcript state when the session changes.
  useEffect(() => {
    resetIdCounter();
    toolIndexRef.current = new Map();
    setItems([]);
    setTotals(EMPTY_TOTALS);
  }, [sessionId]);

  // Feed new SSE events into the transcript.
  useEffect(() => {
    if (events.length === 0) return;

    // Only process events that arrived since our last render. Because
    // useSseStream accumulates ALL events, we track how many we've seen.
    // We use a ref to avoid this effect depending on items/totals state.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processedCount is intentionally a ref
  }, [events]);

  // A ref-based approach: process events incrementally without depending on
  // items or totals as effect deps (which would cause infinite re-renders).
  const processedCountRef = useRef(0);

  useEffect(() => {
    const newEvents = events.slice(processedCountRef.current);
    if (newEvents.length === 0) return;
    processedCountRef.current = events.length;

    const toolIndex = toolIndexRef.current;
    const newItems: TranscriptItem[] = [];
    let deltaTotals: SessionTotals = EMPTY_TOTALS;
    let hasMutation = false;

    for (const raw of newEvents) {
      // Each SSE frame is { record: LedgerRecordLike, replay: boolean }.
      const frame = raw as { record?: unknown; replay?: boolean };
      const record = (frame.record ?? raw) as LedgerRecordLike;

      // Accumulate totals from done records.
      deltaTotals = accumulateTotals(deltaTotals, record);

      // Convert record to a transcript item. ledgerRecordToItem may mutate an
      // existing tool item (for tool_result) and return undefined — in that
      // case we set hasMutation so we trigger a re-render of the items array.
      const item = ledgerRecordToItem(record, toolIndex);
      if (item !== undefined) {
        newItems.push(item);
      } else if (record.kind === 'tool_result') {
        // A tool_result mutated an existing item in place; signal re-render.
        hasMutation = true;
      }
    }

    if (newItems.length > 0) {
      setItems((prev) => [...prev, ...newItems]);
    } else if (hasMutation) {
      // Force a new array reference so React re-renders with mutated tool items.
      setItems((prev) => [...prev]);
    }

    if (
      deltaTotals.costUsd !== 0 ||
      deltaTotals.durationMs !== 0 ||
      deltaTotals.turns !== 0
    ) {
      setTotals((prev) => ({
        costUsd: prev.costUsd + deltaTotals.costUsd,
        durationMs: prev.durationMs + deltaTotals.durationMs,
        turns: prev.turns + deltaTotals.turns,
        inputTokens: (prev.inputTokens ?? 0) + (deltaTotals.inputTokens ?? 0),
        outputTokens: (prev.outputTokens ?? 0) + (deltaTotals.outputTokens ?? 0),
        cacheReadTokens: (prev.cacheReadTokens ?? 0) + (deltaTotals.cacheReadTokens ?? 0),
      }));
    }
  }, [events]);

  // Reset processed count on session change (after items/totals are cleared).
  useEffect(() => {
    processedCountRef.current = 0;
  }, [sessionId]);

  return { items, totals, status, error };
}
