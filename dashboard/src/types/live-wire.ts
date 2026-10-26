/**
 * Browser-safe mirror of src/web-server/shared/live-wire.ts. Keep in sync.
 *
 * Live frames are id-less SSE frames, never ledger records: `seg` matches the
 * `seg` of the durable assistant/thinking record that later replaces the draft.
 * `turn` disambiguates segments across turns (`seg` restarts at 0 per turn).
 */
export type LivePart = 'text' | 'thinking';

export type LiveSsePayload =
  | { type: 'live_snapshot'; turn: number; seg: number; part: LivePart; text: string }
  | { type: 'live_delta'; turn: number; seg: number; part: LivePart; offset: number; text: string }
  | { type: 'live_seal'; turn: number; seg: number; part: LivePart }
  | { type: 'live_end'; turn: number; reason: 'done' | 'error' | 'aborted' };

/** Client-only: the connection was reset/reconnected; drafts must be rebuilt from the next snapshot. */
export type LiveClientEvent = LiveSsePayload | { type: 'live_reset' };

export function isLivePayload(value: unknown): value is LiveSsePayload {
  return typeof value === 'object' && value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('live_');
}
