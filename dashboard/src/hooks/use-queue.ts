/**
 * React hook for the mid-run message queue.
 *
 * Manages a list of queued prompts with reorder/edit/remove operations,
 * and a one-at-a-time drain that sends the next entry only when the current
 * turn is idle. Pure immutable list operations ported from
 * src/web-server/frontend/queue-reorder.ts.
 *
 * Contract: the queue holds entries and drains them one at a time on turn
 * boundaries. POST /prompt answers 202 on ACCEPTANCE, not completion, so a
 * while(queue.length) drain would empty the list instantly. Holding the rest
 * until the turn finishes is what lets entries dwell long enough to reorder.
 *
 * Each entry carries a stable numeric `id` so that after the in-flight POST
 * succeeds the correct entry is removed by identity, not by position.
 */

import { useCallback, useRef, useState } from 'react';

// ---- queue entry type -------------------------------------------------------

/** A queued prompt with a stable identity. */
export interface QueueEntry {
  id: number;
  text: string;
}

// ---- pure list operations (from queue-reorder.ts) ---------------------------

function isInBounds<T>(list: readonly T[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < list.length;
}

function moveUp<T>(list: readonly T[], index: number): T[] {
  if (!isInBounds(list, index) || index === 0) return list.slice();
  const next = list.slice();
  const above = next[index - 1];
  const current = next[index];
  if (above === undefined || current === undefined) return list.slice();
  next[index - 1] = current;
  next[index] = above;
  return next;
}

function moveDown<T>(list: readonly T[], index: number): T[] {
  if (!isInBounds(list, index) || index === list.length - 1) return list.slice();
  const next = list.slice();
  const below = next[index + 1];
  const current = next[index];
  if (below === undefined || current === undefined) return list.slice();
  next[index + 1] = current;
  next[index] = below;
  return next;
}

function removeAt<T>(list: readonly T[], index: number): T[] {
  if (!isInBounds(list, index)) return list.slice();
  const next = list.slice();
  next.splice(index, 1);
  return next;
}

function editAt(list: readonly QueueEntry[], index: number, text: string): QueueEntry[] {
  if (!isInBounds(list, index)) return list.slice();
  const next = list.slice();
  next[index] = { ...next[index]! , text };
  return next;
}

// ---- hook -------------------------------------------------------------------

interface UseQueueOpts {
  /** POST one prompt; must reject unless the server accepted it. */
  submit: (text: string) => Promise<void>;
  /** Whether the active session can be driven from this process. */
  isLive: boolean;
}

export interface UseQueueResult {
  entries: readonly QueueEntry[];
  enqueue: (text: string) => void;
  moveItemUp: (index: number) => void;
  moveItemDown: (index: number) => void;
  removeItem: (index: number) => void;
  editItem: (index: number, text: string) => void;
  clear: () => void;
  /** Attempt to flush the next queued entry. Call on turn-boundary events. */
  flush: () => Promise<void>;
}

export function useQueue({ submit, isLive }: UseQueueOpts): UseQueueResult {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const flushingRef = useRef(false);
  const nextIdRef = useRef(0);

  const enqueue = useCallback((text: string) => {
    const id = nextIdRef.current++;
    setQueue((prev) => [...prev, { id, text }]);
  }, []);

  const moveItemUp = useCallback((i: number) => {
    setQueue((prev) => moveUp(prev, i));
  }, []);

  const moveItemDown = useCallback((i: number) => {
    setQueue((prev) => moveDown(prev, i));
  }, []);

  const removeItem = useCallback((i: number) => {
    setQueue((prev) => removeAt(prev, i));
  }, []);

  const editItem = useCallback((i: number, text: string) => {
    setQueue((prev) => editAt(prev, i, text));
  }, []);

  const clear = useCallback(() => setQueue([]), []);

  const flush = useCallback(async () => {
    if (flushingRef.current) return;
    if (!isLive) return;

    setQueue((prev) => {
      const head = prev[0];
      if (head === undefined) return prev;

      const headId = head.id;
      const headText = head.text;

      flushingRef.current = true;
      // Fire-and-forget the submit, then remove by id on success.
      void submit(headText)
        .then(() => {
          // Remove the entry that was submitted, identified by its stable id.
          setQueue((q) => q.filter((entry) => entry.id !== headId));
        })
        .catch(() => {
          // Keep entry in queue on failure; the UI will show error state.
        })
        .finally(() => {
          flushingRef.current = false;
        });

      return prev;
    });
  }, [submit, isLive]);

  return { entries: queue, enqueue, moveItemUp, moveItemDown, removeItem, editItem, clear, flush };
}
