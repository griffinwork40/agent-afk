/**
 * Lazy loader for a tool call's FULL result from the message journal.
 *
 * The SSE stream carries only the ledger's clipped preview of each tool
 * result (live records stay small). When the user asks for the whole output,
 * this hook fetches it once from `GET /api/sessions/:id/tool-results/:toolUseId`.
 *
 * Contract: nothing is fetched until `load()` is called. The session id comes
 * from {@link TranscriptSessionContext}, which the transcript view provides;
 * outside that provider (or for a tool row with no toolUseId) `canLoad` is
 * false and `load()` is a no-op.
 *
 * Invariant: each in-flight fetch is owned by the (sessionId, toolUseId) pair
 * that started it. When the session or tool row changes, or the component
 * unmounts, the pending request is aborted via AbortController, and its
 * completion callbacks drop the result once their signal is aborted, so a
 * stale response never lands in the new row's state.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { toolResultPath } from '@/lib/ledger-adapter';
import type { ToolResultResponse } from '@/types/api';

/** Session id of the transcript currently rendered; `null` outside a session. */
export const TranscriptSessionContext = createContext<string | null>(null);

export type FullToolResultState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; result: ToolResultResponse }
  | { status: 'error'; message: string };

export interface FullToolResult {
  state: FullToolResultState;
  canLoad: boolean;
  load: () => void;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return err.message.includes('journal_not_found')
      ? 'Full output unavailable: this session has no message journal.'
      : 'Full output not found in the session journal.';
  }
  return err instanceof Error ? err.message : String(err);
}

export function useFullToolResult(toolUseId: string | undefined): FullToolResult {
  const sessionId = useContext(TranscriptSessionContext);
  const [state, setState] = useState<FullToolResultState>({ status: 'idle' });
  const canLoad = sessionId !== null && toolUseId !== undefined && toolUseId.length > 0;
  // Track the AbortController for any in-flight request so we can cancel it
  // when sessionId or toolUseId changes before the fetch completes.
  const abortRef = useRef<AbortController | null>(null);

  // A different call (or session) invalidates what was loaded. The cleanup runs
  // before the next (sessionId, toolUseId) takes effect AND on unmount, aborting
  // any pending fetch so the old promise cannot install its result.
  useEffect(() => {
    setState({ status: 'idle' });
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [sessionId, toolUseId]);

  const load = useCallback(() => {
    if (!canLoad || sessionId === null || toolUseId === undefined) return;
    // Abort any previous in-flight fetch before starting a new one.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ status: 'loading' });
    // The aborted-signal check is the stale-result guard: this controller is
    // aborted whenever the (sessionId, toolUseId) pair changes, the component
    // unmounts, or a newer load() supersedes it.
    apiFetch<ToolResultResponse>(toolResultPath(sessionId, toolUseId), { signal: ac.signal }).then(
      (result) => {
        if (ac.signal.aborted) return;
        setState({ status: 'loaded', result });
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        setState({ status: 'error', message: describeError(err) });
      },
    );
  }, [canLoad, sessionId, toolUseId]);

  return { state, canLoad, load };
}
