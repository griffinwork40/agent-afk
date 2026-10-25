/**
 * Per-session, client-local command output items.
 *
 * Contract: bounded sessionStorage history survives reload in this tab only.
 * No command responses are sent back to the server. Each item records
 * `afterCount`, the number of transcript items that were visible when the
 * command ran, so the transcript can render it at that position rather than
 * pinning every output to the bottom.
 */

import { useCallback, useEffect, useState } from 'react';
import type { CommandResponse } from '@/types/command-wire';

export interface CommandOutputItem {
  /** Stable insertion key, monotonically increasing across all sessions. */
  key: number;
  input: string;
  response: CommandResponse;
  /** Transcript length at the moment the output arrived. */
  afterCount: number;
}

export interface UseCommandOutputsResult {
  /** Ordered output items for one session (empty when none). */
  itemsFor: (sessionId: string | null) => CommandOutputItem[];
  clearItems: (sessionId: string, preserveClearConfirmation?: boolean) => void;
  /** Append an output for a session, anchored after `afterCount` transcript items. */
  addItem: (sessionId: string, input: string, response: CommandResponse, afterCount: number) => void;
}

const EMPTY: CommandOutputItem[] = [];
let nextKey = 0;
const STORAGE_KEY = 'afk.command-outputs.v1';
const MAX_STORAGE_BYTES = 1_000_000;

function restoreOutputs(): Record<string, CommandOutputItem[]> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_STORAGE_BYTES) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, CommandOutputItem[]> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const items = value.filter((item): item is CommandOutputItem =>
        !!item && typeof item.key === 'number' && typeof item.input === 'string' &&
        Number.isInteger(item.afterCount) && item.afterCount >= 0 &&
        Array.isArray(item.response?.blocks) && typeof item.response?.control?.kind === 'string');
      result[id] = items;
      for (const item of items) nextKey = Math.max(nextKey, item.key);
    }
    return result;
  } catch { return {}; }
}

export function useCommandOutputs(): UseCommandOutputsResult {
  const [bySession, setBySession] = useState<Record<string, CommandOutputItem[]>>(restoreOutputs);
  useEffect(() => {
    try {
      // Bound retained history, evicting oldest sessions before exceeding the tab quota.
      const retained = Object.fromEntries(Object.entries(bySession).slice(-20).map(([id, items]) => [id, items.slice(-50)]));
      let json = JSON.stringify(retained);
      while (json.length > MAX_STORAGE_BYTES && Object.keys(retained).length) {
        delete retained[Object.keys(retained)[0]!];
        json = JSON.stringify(retained);
      }
      sessionStorage.setItem(STORAGE_KEY, json);
    } catch { /* Storage disabled/full: in-memory command output still works. */ }
  }, [bySession]);

  const addItem = useCallback(
    (sessionId: string, input: string, response: CommandResponse, afterCount: number) => {
      const cleared = response.control.kind === 'clear';
      const hasContent = response.blocks.some((b) => b.text.trim().length > 0);
      // When a /model switch succeeds the server returns a session metadata
      // payload but the blocks are empty (the command handler writes to a REPL
      // writer that is discarded server-side for the web path).  Synthesise a
      // single concise confirmation line so the user sees feedback without an
      // empty block being left in the transcript.
      const effectiveResponse: CommandResponse = (!hasContent && response.session?.model)
        ? {
            ...response,
            blocks: [{ text: `Switched to ${response.session.model}`, ansi: '' }],
          }
        : response;
      // Drop entirely when there is nothing to show and no meaningful metadata.
      const effectiveContent = effectiveResponse.blocks.some((b) => b.text.trim().length > 0);
      if (!effectiveContent && response.control.kind === 'continue') return;
      const item: CommandOutputItem = {
        key: ++nextKey, input, response: effectiveResponse, afterCount: cleared ? 0 : afterCount,
      };
      // Keep the clear confirmation, but discard all previous local outputs.
      setBySession((prev) => ({
        ...prev, [sessionId]: [...(cleared ? EMPTY : prev[sessionId] ?? EMPTY), item],
      }));
    },
    [],
  );

  const clearItems = useCallback((sessionId: string, preserveClearConfirmation = false) => {
    setBySession((prev) => {
      const confirmation = preserveClearConfirmation
        ? [...(prev[sessionId] ?? EMPTY)].reverse().find((item) => item.response.control.kind === 'clear')
        : undefined;
      return { ...prev, [sessionId]: confirmation ? [confirmation] : EMPTY };
    });
  }, []);

  const itemsFor = useCallback(
    (sessionId: string | null) => (sessionId === null ? EMPTY : bySession[sessionId] ?? EMPTY),
    [bySession],
  );

  return { itemsFor, addItem, clearItems };
}
