/**
 * Browser-safe ephemeral live-text wire (mirrored in dashboard/src/types/live-wire.ts).
 *
 * Live frames are id-less SSE frames: they never advance the durable ledger
 * cursor and are never written to the ledger. `seg` matches the `seg` of the
 * durable `assistant` / `thinking` record that later replaces the draft (both
 * numbered by `SegmentTracker`). `offset` is the draft length before `text`,
 * so a client drops duplicates and detects gaps (then waits for a snapshot).
 * `turn` is the broker's per-session turn sequence: `seg` restarts at 0 every
 * turn, so drafts are keyed `turn:part:seg` or turn N+1's seg 0 collides with
 * turn N's (the bug where only the first turn after a reset streamed).
 */
export type LivePart = 'text' | 'thinking';

export type LiveSsePayload =
  | { type: 'live_snapshot'; turn: number; seg: number; part: LivePart; text: string }
  | { type: 'live_delta'; turn: number; seg: number; part: LivePart; offset: number; text: string }
  | { type: 'live_seal'; turn: number; seg: number; part: LivePart }
  | { type: 'live_end'; turn: number; reason: 'done' | 'error' | 'aborted' };
