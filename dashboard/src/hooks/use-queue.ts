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
  // Mirror of the queue state readable synchronously without a state-updater
  // side effect — avoids running side effects inside the setQueue updater
  // (which React 18 StrictMode invokes twice).
  const queueRef = useRef<QueueEntry[]>([]);

  const enqueue = useCallback((text: string) => {
    const id = nextIdRef.current++;
    const next = [...queueRef.current, { id, text }];
    queueRef.current = next;
    setQueue(next);
  }, []);

  const moveItemUp = useCallback((i: number) => {
    const next = moveUp(queueRef.current, i);
    queueRef.current = next;
    setQueue(next);
  }, []);

  const moveItemDown = useCallback((i: number) => {
    const next = moveDown(queueRef.current, i);
    queueRef.current = next;
    setQueue(next);
  }, []);

  const removeItem = useCallback((i: number) => {
    const next = removeAt(queueRef.current, i);
    queueRef.current = next;
    setQueue(next);
  }, []);

  const editItem = useCallback((i: number, text: string) => {
    const next = editAt(queueRef.current, i, text);
    queueRef.current = next;
    setQueue(next);
  }, []);

  const clear = useCallback(() => {
    queueRef.current = [];
    setQueue([]);
  }, []);

  const flush = useCallback(async () => {
    if (flushingRef.current) return;
    if (!isLive) return;

    // Read the queue head synchronously from the ref — no state-updater side
    // effect, so React 18 StrictMode double-invocation is harmless.
    const head = queueRef.current[0];
    if (head === undefined) return;

    const headId = head.id;
    const headText = head.text;

    flushingRef.current = true;
    // Fire-and-forget the submit, then remove by id on success.
    void submit(headText)
      .then(() => {
        // Remove the entry that was submitted, identified by its stable id.
        const next = queueRef.current.filter((entry) => entry.id !== headId);
        queueRef.current = next;
        setQueue(next);
      })
      .catch(() => {
        // Keep entry in queue on failure so the user can retry or remove it.
      })
      .finally(() => {
        flushingRef.current = false;
      });
  }, [submit, isLive]);

  return { entries: queue, enqueue, moveItemUp, moveItemDown, removeItem, editItem, clear, flush };
}
