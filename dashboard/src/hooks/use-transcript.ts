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
import type { LedgerRecordLike, SessionTotals, SubagentIndex, ToolIndex, TranscriptItem } from '@/lib/ledger-adapter';

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
  /**
   * True while the agent is actively processing a turn.
   * Set to true on `user` ledger records, cleared on `done` or `error` records.
   * Use this to drive the Composer's busy state instead of deriving from
   * SSE connection status (which stays `open` even when the agent is idle).
   */
  turnActive: boolean;
  /**
   * Count of live (non-replay) `done` records received since session load.
   * Unlike `totals.turns` — which counts ALL done records including historical
   * replay frames — this only increments on frames where `replay` is false.
   * Use this as the flush trigger to avoid spurious queue flushes during
   * the initial replay burst on session load.
   */
  liveTurns: number;
}

export function useTranscript(sessionId: string | null): UseTranscriptResult {
  const { events, status, error } = useSseStream(sessionId);

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [totals, setTotals] = useState<SessionTotals>(EMPTY_TOTALS);
  const [turnActive, setTurnActive] = useState(false);
  const [liveTurns, setLiveTurns] = useState(0);

  // Stable indexes across renders — reset when sessionId changes.
  // toolIndex correlates tool_result records back to their tool items.
  // subagentIndex deduplicates lifecycle events (started → succeeded/failed).
  const toolIndexRef = useRef<ToolIndex>(new Map());
  const subagentIndexRef = useRef<SubagentIndex>(new Map());

  // Reset transcript state when the session changes.
  useEffect(() => {
    resetIdCounter();
    toolIndexRef.current = new Map();
    subagentIndexRef.current = new Map();
    setItems([]);
    setTotals(EMPTY_TOTALS);
    setTurnActive(false);
    setLiveTurns(0);
  }, [sessionId]);

  // Feed new SSE events into the transcript incrementally. We track how many
  // events we have processed via a ref to avoid depending on items/totals as
  // effect deps (which would cause infinite re-renders).
  const processedCountRef = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- processedCountRef is intentionally a ref; adding it would cause infinite re-renders
  useEffect(() => {
    const newEvents = events.slice(processedCountRef.current);
    if (newEvents.length === 0) return;
    processedCountRef.current = events.length;

    const toolIndex = toolIndexRef.current;
    const newItems: TranscriptItem[] = [];
    let deltaTotals: SessionTotals = EMPTY_TOTALS;
    let hasMutation = false;
    let nextTurnActive: boolean | null = null;
    let liveTurnsDelta = 0;

    for (const raw of newEvents) {
      // Each SSE frame is { record: LedgerRecordLike, replay: boolean }.
      const frame = raw as { record?: unknown; replay?: boolean };
      const record = (frame.record ?? raw) as LedgerRecordLike;
      const isReplay = frame.replay === true;

      // Track turn activity: user records start a turn; done/error records end it.
      if (record.kind === 'user') {
        nextTurnActive = true;
      } else if (record.kind === 'done' || record.kind === 'error') {
        nextTurnActive = false;
      }

      // Count live (non-replay) done records for the flush trigger.
      if (record.kind === 'done' && !isReplay) {
        liveTurnsDelta += 1;
      }

      // Accumulate totals from done records.
      deltaTotals = accumulateTotals(deltaTotals, record);

      // Convert record to a transcript item. ledgerRecordToItem may mutate an
      // existing tool item (for tool_result) and return undefined — in that
      // case we set hasMutation so we trigger a re-render of the items array.
      const item = ledgerRecordToItem(record, toolIndex, subagentIndexRef.current);
      if (item !== undefined) {
        newItems.push(item);
      } else if (record.kind === 'tool_result' || record.kind === 'subagent_lifecycle') {
        // Mutated an existing item in place; signal re-render.
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

    if (nextTurnActive !== null) {
      setTurnActive(nextTurnActive);
    }

    if (liveTurnsDelta > 0) {
      setLiveTurns((prev) => prev + liveTurnsDelta);
    }
  }, [events]);

  // Reset processed count on session change (after items/totals are cleared).
  useEffect(() => {
    processedCountRef.current = 0;
  }, [sessionId]);

  return { items, totals, status, error, turnActive, liveTurns };
}
