/**
 * Live draft text for the turn in progress.
 *
 * Invariant: drafts are a render-only overlay. They are keyed by
 * `turn:part:seg` (seg numbered by the server's SegmentTracker, the same
 * numbering the durable ledger records carry; turn by the live broker, since
 * seg restarts at 0 every turn) and always render AFTER every durable item.
 * When the durable `assistant`/`thinking` record with the same part:seg
 * arrives, `claim` hands the OLDEST matching draft's id to the durable item
 * (durable records carry no turn, and a late turn-N record must never claim
 * turn N+1's draft) and drops it, so React keeps the same DOM node. Rules:
 *   - `live_reset` (reconnect / ledger reset) clears drafts; the server's next
 *     `live_snapshot` rebuilds the open segments;
 *   - a `live_delta` whose offset does not continue the draft is a gap: the
 *     draft is marked stale and ignores deltas until the next snapshot;
 *   - a durable `done`/`error` (`settle`) drops the ended turn's drafts (those
 *     sealed or ended), never a next turn's streaming draft;
 *   - live frames for a seg already claimed by a durable record are ignored
 *     until the live turn ends (guards a durable-before-live race);
 *   - `live_end` aborted keeps unmatched drafts as "interrupted" items.
 * Updates are coalesced to one React state change per animation frame.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptItem } from '@/lib/ledger-adapter';
import type { LiveClientEvent, LivePart } from '@/types/live-wire';

export type LiveState = 'streaming' | 'sealed' | 'interrupted';

interface Draft {
  id: string;
  turn: number;
  seg: number;
  part: LivePart;
  text: string;
  state: LiveState;
  stale: boolean;
}

/** A transcript item carrying its live draft state (absent on durable items). */
export type LiveTranscriptItem = TranscriptItem & { live?: LiveState };

export function liveStateOf(item: TranscriptItem): LiveState | undefined {
  return (item as LiveTranscriptItem).live;
}

let draftCounter = 0;
const key = (turn: number, part: LivePart, seg: number): string => `${turn}:${part}:${seg}`;
/** Old servers (pre turn field) number every frame turn 0. */
const turnOf = (event: { turn?: number }): number => event.turn ?? 0;

/** Oldest draft for part:seg (lowest turn): durable records arrive in turn order. */
function oldest(map: Map<string, Draft>, part: LivePart, seg: number): [string, Draft] | undefined {
  let best: [string, Draft] | undefined;
  for (const entry of map) {
    const d = entry[1];
    if (d.part === part && d.seg === seg && (!best || d.turn < best[1].turn)) best = entry;
  }
  return best;
}

function toItem(d: Draft): LiveTranscriptItem {
  return d.part === 'text'
    ? { kind: 'assistant', id: d.id, text: d.text, live: d.state }
    : { kind: 'thinking', id: d.id, text: d.text, live: d.state };
}

const schedule = (cb: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const h = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(h);
  }
  const t = setTimeout(cb, 16);
  return () => clearTimeout(t);
};

export interface UseLiveDraftsResult {
  drafts: LiveTranscriptItem[];
  onLive: (event: LiveClientEvent) => void;
  /** Durable record for `part:seg` arrived: returns the draft id to reuse. */
  claim: (part: LivePart, seg: number) => string | undefined;
  /** Durable turn end: drop all drafts. */
  settle: () => void;
  /** Session/generation change: drop everything. */
  clearAll: () => void;
}

export function useLiveDrafts(): UseLiveDraftsResult {
  const draftsRef = useRef(new Map<string, Draft>());
  const interruptedRef = useRef(new Map<string, Draft>());
  const claimedRef = useRef(new Set<string>());
  // Newest turn seen in a live frame, and whether its live_end arrived.
  const liveTurnRef = useRef<{ turn: number; ended: boolean } | undefined>(undefined);
  const [drafts, setDrafts] = useState<LiveTranscriptItem[]>([]);
  const cancelRef = useRef<(() => void) | undefined>(undefined);

  const publishNow = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = undefined;
    const all = [...interruptedRef.current.values(), ...[...draftsRef.current.values()].sort((a, b) => a.turn - b.turn || a.seg - b.seg)];
    setDrafts(all.filter((d) => d.text.length > 0).map(toItem));
  }, []);
  const publish = useCallback(() => {
    if (cancelRef.current) return;
    cancelRef.current = schedule(() => { cancelRef.current = undefined; publishNow(); });
  }, [publishNow]);
  useEffect(() => () => cancelRef.current?.(), []);

  const onLive = useCallback((event: LiveClientEvent) => {
    const map = draftsRef.current;
    if (event.type !== 'live_reset') {
      const turn = turnOf(event);
      const cur = liveTurnRef.current;
      if (!cur || turn > cur.turn) liveTurnRef.current = { turn, ended: false };
    }
    switch (event.type) {
      case 'live_reset':
        // Reconnect / ledger reset / server restart (turn numbers restart):
        // the next snapshot rebuilds open segments, so turn state starts over.
        map.clear();
        claimedRef.current.clear();
        liveTurnRef.current = undefined;
        break;
      case 'live_snapshot': {
        const k = key(turnOf(event), event.part, event.seg);
        if (claimedRef.current.has(k)) return;
        const prev = map.get(k);
        map.set(k, { id: prev?.id ?? `live-${++draftCounter}`, turn: turnOf(event), seg: event.seg, part: event.part,
          text: event.text, state: 'streaming', stale: false });
        break;
      }
      case 'live_delta': {
        const k = key(turnOf(event), event.part, event.seg);
        if (claimedRef.current.has(k)) return;
        let d = map.get(k);
        if (!d && event.offset === 0) {
          d = { id: `live-${++draftCounter}`, turn: turnOf(event), seg: event.seg, part: event.part, text: '', state: 'streaming', stale: false };
          map.set(k, d);
        }
        if (!d || d.stale) return;
        const end = event.offset + event.text.length;
        if (event.offset > d.text.length) { d.stale = true; return; }
        if (end <= d.text.length) return; // duplicate
        d.text += event.text.slice(d.text.length - event.offset);
        break;
      }
      case 'live_seal': {
        const d = map.get(key(turnOf(event), event.part, event.seg));
        if (d) d.state = 'sealed';
        break;
      }
      case 'live_end': {
        const turn = turnOf(event);
        if (liveTurnRef.current?.turn === turn) liveTurnRef.current.ended = true;
        // Older turns' claims can never be hit again (frames are turn-ordered).
        // Guard against malformed keys by using Number.isFinite instead of a
        // raw Number() cast (NaN < turn is always false, leaking the key).
        for (const k of claimedRef.current) {
          const t = Number(k.split(':')[0]);
          if (Number.isFinite(t) && t < turn) claimedRef.current.delete(k);
        }
        for (const [k, d] of map) {
          if (d.turn > turn) continue; // a next turn's draft is not ended by this frame
          if (event.reason === 'aborted') {
            interruptedRef.current.set(k, { ...d, state: 'interrupted' });
            map.delete(k);
          } else {
            // done/error: drafts stay until their durable records claim them.
            d.state = 'sealed';
          }
        }
        break;
      }
    }
    publish();
  }, [publish]);

  const claim = useCallback((part: LivePart, seg: number): string | undefined => {
    // An interrupted turn's late durable flush matches its own draft first.
    const found = oldest(interruptedRef.current, part, seg) ?? oldest(draftsRef.current, part, seg);
    if (!found) {
      // Durable-before-live: guard the still-running turn's segment so its
      // late live frames cannot raise a duplicate draft. Never guard an ended
      // turn: the next turn reuses the same part:seg under a new turn number.
      const cur = liveTurnRef.current;
      if (cur && !cur.ended) claimedRef.current.add(key(cur.turn, part, seg));
      return undefined;
    }
    const [k, d] = found;
    if (interruptedRef.current.get(k) === d) interruptedRef.current.delete(k);
    else { draftsRef.current.delete(k); claimedRef.current.add(k); }
    publishNow();
    return d.id;
  }, [publishNow]);

  const settle = useCallback(() => {
    // Drop sealed drafts for the current turn and all earlier turns, regardless
    // of whether live_end arrived. A durable `done`/`stopped` record means the
    // turn is over even if the connection dropped before live_end was received.
    // Future turn drafts (d.turn > cur.turn) are protected: they are a next
    // turn's pre-tool sealed draft and must survive the previous turn's late `done`.
    const cur = liveTurnRef.current;
    let changed = false;
    for (const [k, d] of draftsRef.current) {
      const ended = !cur || d.turn < cur.turn || (d.turn === cur.turn && cur.ended);
      if (d.state === 'sealed' && ended) { draftsRef.current.delete(k); changed = true; }
    }
    if (changed) publishNow();
  }, [publishNow]);

  const clearAll = useCallback(() => {
    draftsRef.current.clear();
    claimedRef.current.clear();
    interruptedRef.current.clear();
    liveTurnRef.current = undefined;
    publishNow();
  }, [publishNow]);

  return { drafts, onLive, claim, settle, clearAll };
}
