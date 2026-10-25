/**
 * Server-instance-scoped live text broker (ChoiceBroker-shaped, never ledger).
 *
 * The owner taps every event of a web-owned turn into `observe`; the broker
 * runs the same `SegmentTracker` rules as the ledger writer so live draft
 * segment numbers match the durable records that later replace them. Deltas
 * are batched (~50 ms) to bound SSE frame rate. Memory is bounded to the OPEN
 * segments of each session: sealed text reaches clients via the ledger tail.
 *
 * @module web-server/live-broker
 */
import type { OutputEvent } from '../agent/types/session-types.js';
import { SegmentTracker, type SegmentStep } from '../agent/session-ledger-segments.js';
import type { LivePart, LiveSsePayload } from './shared/live-wire.js';

type Subscriber = (event: LiveSsePayload) => void;
export type LiveEndReason = 'done' | 'error' | 'aborted';

export const LIVE_BATCH_MS = 50;

interface PendingDelta { seg: number; part: LivePart; offset: number; text: string }

interface SessionLive {
  /** Per-session turn sequence (survives endTurn via `turnSeq`). */
  turn: number;
  tracker: SegmentTracker;
  pending: PendingDelta[];
  timer: ReturnType<typeof setTimeout> | undefined;
  ended: LiveEndReason | undefined;
}

/** Sink the session owner taps turn events into. */
export interface LiveSink {
  beginTurn(sessionId: string): void;
  observe(sessionId: string, event: OutputEvent): void;
  endTurn(sessionId: string, reason: LiveEndReason): void;
}

export class LiveBroker implements LiveSink {
  private readonly sessions = new Map<string, SessionLive>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  // Monotonic per-session turn counter. Lives outside `sessions` (dropped at
  // endTurn) so turn N+1 never reuses turn N's number: clients key drafts on
  // `turn:part:seg` because `seg` restarts at 0 every turn.
  private readonly turnSeq = new Map<string, number>();

  constructor(private readonly batchMs = LIVE_BATCH_MS) {}

  /** Attach a client; returns the unsubscribe function. Send `snapshot` separately. */
  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(sessionId, set);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  /** Current open segments as snapshot frames (includes not-yet-flushed deltas). */
  snapshot(sessionId: string): LiveSsePayload[] {
    const live = this.sessions.get(sessionId);
    if (!live) return [];
    return live.tracker.openSegments().map((s) => ({ type: 'live_snapshot', turn: live.turn, seg: s.seg, part: s.part, text: s.text }));
  }

  beginTurn(sessionId: string): void {
    const live = this.sessions.get(sessionId) ?? this.create(sessionId);
    this.flushPending(sessionId, live);
    live.tracker.beginTurn();
    live.ended = undefined;
    const turn = (this.turnSeq.get(sessionId) ?? 0) + 1;
    this.turnSeq.set(sessionId, turn);
    live.turn = turn;
  }

  observe(sessionId: string, event: OutputEvent): void {
    const live = this.sessions.get(sessionId) ?? this.create(sessionId);
    for (const step of live.tracker.observe(event)) this.apply(sessionId, live, step);
    if (event.type === 'done' || event.type === 'error') live.ended = event.type;
  }

  /** Always called once per turn (in a finally): flushes and drops turn state. */
  endTurn(sessionId: string, reason: LiveEndReason): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    const final = live.ended ?? reason;
    for (const step of live.tracker.flush()) this.apply(sessionId, live, step);
    this.flushPending(sessionId, live);
    this.sessions.delete(sessionId);
    this.publish(sessionId, { type: 'live_end', turn: live.turn, reason: final });
  }

  cancelAll(): void {
    for (const live of this.sessions.values()) clearTimeout(live.timer);
    this.sessions.clear();
    this.subscribers.clear();
    this.turnSeq.clear();
  }

  private create(sessionId: string): SessionLive {
    const live: SessionLive = { turn: this.turnSeq.get(sessionId) ?? 0, tracker: new SegmentTracker(), pending: [], timer: undefined, ended: undefined };
    this.sessions.set(sessionId, live);
    return live;
  }

  private apply(sessionId: string, live: SessionLive, step: SegmentStep): void {
    if (step.op === 'record') return;
    if (step.op === 'delta') {
      const last = live.pending[live.pending.length - 1];
      if (last && last.seg === step.seg && last.part === step.part && last.offset + last.text.length === step.offset) {
        last.text += step.text;
      } else {
        live.pending.push({ seg: step.seg, part: step.part, offset: step.offset, text: step.text });
      }
      if (live.timer === undefined) {
        live.timer = setTimeout(() => this.flushPending(sessionId, live), this.batchMs);
        live.timer.unref?.();
      }
      return;
    }
    // Ordering: pending deltas of a segment go out before its seal/reset.
    this.flushPending(sessionId, live);
    if (step.op === 'seal') this.publish(sessionId, { type: 'live_seal', turn: live.turn, seg: step.seg, part: step.part });
    else this.publish(sessionId, { type: 'live_snapshot', turn: live.turn, seg: step.seg, part: step.part, text: '' });
  }

  private flushPending(sessionId: string, live: SessionLive): void {
    clearTimeout(live.timer);
    live.timer = undefined;
    const batch = live.pending;
    live.pending = [];
    for (const d of batch) this.publish(sessionId, { type: 'live_delta', turn: live.turn, ...d });
  }

  private publish(sessionId: string, event: LiveSsePayload): void {
    for (const subscriber of this.subscribers.get(sessionId) ?? []) {
      // A failed SSE write must neither block peers nor the turn.
      try { subscriber(event); } catch { /* transport cleanup belongs to its owner */ }
    }
  }
}
