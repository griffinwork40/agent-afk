/**
 * Pure elapsed-display update check for ToolLane.
 *
 * Extracted from tool-lane.ts so that file stays under its baselined
 * code-line ceiling (issue #1505).
 *
 * @module cli/commands/interactive/tool-lane.elapsed-check
 */

import { ELAPSED_GRACE_MS } from '../../terminal-compositor.scrollback.js';
import type { Entry } from './tool-lane-render.js';

/**
 * Check whether any in-flight tool entry's displayed elapsed counter has
 * advanced to a new second since the last call. Returns `true` when at
 * least one entry's elapsed display has changed — the caller should mark
 * the tool-lane overlay slot dirty to trigger a repaint.
 *
 * Intentionally does NOT count seconds below {@link ELAPSED_GRACE_MS}: the
 * grace-period branch of `formatElapsed` emits an empty string, so there is
 * nothing to repaint until the grace period expires.
 *
 * @param entries          Live entry map (keyed by toolUseId).
 * @param order            Insertion-order id list.
 * @param lastElapsedSecond Per-entry mutable tracking map (mutated in place).
 */
export function elapsedDisplayNeedsUpdate(
  entries: ReadonlyMap<string, Entry>,
  order: readonly string[],
  lastElapsedSecond: Map<string, number>,
): boolean {
  const now = Date.now();
  let changed = false;
  // Prune tracking entries for IDs that are no longer in-flight.
  for (const id of lastElapsedSecond.keys()) {
    const entry = entries.get(id);
    if (!entry || entry.kind !== 'tool' || entry.result !== undefined) {
      lastElapsedSecond.delete(id);
    }
  }
  for (const id of order) {
    const entry = entries.get(id);
    if (!entry || entry.kind !== 'tool' || entry.result !== undefined) continue;
    const elapsedMs = now - entry.startedAt;
    if (elapsedMs < ELAPSED_GRACE_MS) continue; // within grace period — display is ''
    const currentSec = Math.floor(elapsedMs / 1000);
    const lastSec = lastElapsedSecond.get(id);
    if (lastSec === undefined || currentSec !== lastSec) {
      lastElapsedSecond.set(id, currentSec);
      changed = true;
    }
  }
  return changed;
}
