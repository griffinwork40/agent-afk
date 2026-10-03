/**
 * Deferred peer-inbox sweep at interactive REPL startup.
 *
 * Fires a fire-and-forget `sweepPeerInboxes` call approximately 5 seconds
 * after the REPL starts, using the same delay and `.unref()` pattern as the
 * witness sweep (`session-setup.ts:scheduleTopLevelHousekeeping`). The sweep
 * removes inbox directories belonging to sessions that are no longer live,
 * and alongside it reaps presence files whose owning process is proven gone
 * (`sweepDeadPresence`).
 *
 * Contract:
 *   - Never throws: errors are caught inside `sweepPeerInboxes` itself, and
 *     the outer promise is discarded via `void`.
 *   - Never delays startup: the setTimeout fires off the construction path.
 *   - The timer is `.unref()`'d so a short-lived process exits without paying
 *     for the sweep (matching the witness-sweep invariant).
 *   - `readLivePresenceFiles` is called inside the timeout callback (at sweep
 *     time, not at schedule time) so the presence list is fresh.
 *
 * @module cli/commands/interactive/peer-inbox-startup-sweep
 */

import { sweepPeerInboxes } from '../../../agent/peer/inbox-store.js';
import { readLivePresenceFiles } from '../../../agent/awareness/presence.js';
import { sweepDeadPresence } from '../../../agent/awareness/presence.reaper.js';

/** Mirrors `WITNESS_SWEEP_START_DELAY_MS` in `session-setup.ts`. */
const PEER_SWEEP_START_DELAY_MS = 5000;

/**
 * Schedule a one-shot deferred sweep of dead sessions' peer inboxes.
 * Call once from `runReplLoop` (or equivalent REPL startup) — the call is
 * idempotent from the caller's perspective (the timer fires once and exits).
 *
 * Exported for tests: pass `delayMs: 0` and `await` the returned promise
 * to exercise the sweep synchronously.
 */
export function schedulePeerInboxSweep(delayMs = PEER_SWEEP_START_DELAY_MS): void {
  const timer = setTimeout(() => {
    // Reap presence files whose owner is proven gone (ESRCH only — see
    // presence.reaper.ts). Fire-and-forget, independent of the inbox sweep.
    void sweepDeadPresence().catch(() => undefined);
    void (async () => {
      try {
        const records = await readLivePresenceFiles();
        const liveSessionIds = new Set(records.map((r) => r.sessionId));
        await sweepPeerInboxes({ liveSessionIds });
      } catch {
        // Best-effort — must never throw or surface errors to the REPL.
      }
    })();
  }, delayMs);
  timer.unref?.();
}
