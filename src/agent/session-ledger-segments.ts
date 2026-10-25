/**
 * Segment numbering for streamed assistant text and thinking.
 *
 * Invariant: this tracker is the SINGLE source of segment numbering for both
 * the durable ledger writer (`SessionLedgerWriter`) and the web live buffer
 * (`web-server/live-broker.ts`). Both feed it the same `OutputEvent` stream of
 * one turn, so a live draft `seg N` and the durable `assistant{seg: N}` record
 * that later replaces it always agree. Rules:
 *   - text deltas append to the open text segment; thinking deltas to the open
 *     thinking segment (one counter per turn shared by both parts);
 *   - a NON-pending `tool_use_detail` seals both open segments, so the
 *     `assistant{seg}` record lands right before its `tool` card (the pending
 *     paint is a placeholder and seals nothing; a wind-down round is a pending
 *     chunk followed by the message, so it records exactly once);
 *   - an assistant `message` is authoritative for the open text segment (it may
 *     carry an appended truncation notice); with no open segment, a message
 *     repeating the last sealed text is dropped (openai-compatible re-emits the
 *     pre-tool text as the terminal message when the final round is textless);
 *   - `done` / `error` / turn start / close flush whatever is still open.
 *
 * @module agent/session-ledger-segments
 */

import type { OutputEvent } from './types/session-types.js';
import { clip, MAX_ASSISTANT_TEXT_LEN, MAX_TEXT_LEN, type LedgerPayload } from './session-ledger-project.js';

export type SegmentPart = 'text' | 'thinking';

/** One effect of observing an event: a live op, or a durable record to write. */
export type SegmentStep =
  | { op: 'delta'; seg: number; part: SegmentPart; offset: number; text: string }
  /** The open segment's buffer restarted (provider stream retry). */
  | { op: 'reset'; seg: number; part: SegmentPart }
  | { op: 'seal'; seg: number; part: SegmentPart }
  | { op: 'record'; payload: LedgerPayload };

interface OpenSegment {
  seg: number;
  buf: string;
}

/** True for the events whose ledger projection is owned by the tracker. */
export function isSegmentEvent(event: OutputEvent): boolean {
  if (event.type === 'message') return true;
  return event.type === 'chunk' && (event.chunk.type === 'content' || event.chunk.type === 'thinking');
}

export class SegmentTracker {
  private next = 0;
  private text: OpenSegment | undefined;
  private thinking: OpenSegment | undefined;
  private lastSealedText: string | undefined;

  /** Flush the previous turn (if any) and restart numbering at 0. */
  beginTurn(): SegmentStep[] {
    const steps = this.flush();
    this.next = 0;
    this.lastSealedText = undefined;
    return steps;
  }

  /** Current open segments (for live snapshots). */
  openSegments(): { seg: number; part: SegmentPart; text: string }[] {
    const out: { seg: number; part: SegmentPart; text: string }[] = [];
    if (this.thinking) out.push({ seg: this.thinking.seg, part: 'thinking', text: this.thinking.buf });
    if (this.text) out.push({ seg: this.text.seg, part: 'text', text: this.text.buf });
    return out.sort((a, b) => a.seg - b.seg);
  }

  observe(event: OutputEvent): SegmentStep[] {
    switch (event.type) {
      case 'chunk': {
        const chunk = event.chunk;
        if (chunk.type === 'content') {
          return [...this.seal('thinking'), ...this.append('text', chunk.content)];
        }
        if (chunk.type === 'thinking') return this.append('thinking', chunk.content);
        if (chunk.type === 'tool_use_detail' && chunk.pending !== true) return this.flush();
        return [];
      }
      case 'message':
        if (event.message.role !== 'assistant' || !event.message.content) return [];
        return [...this.seal('thinking'), ...this.message(event.message.content)];
      case 'stream_retry': {
        const steps: SegmentStep[] = [];
        for (const part of ['thinking', 'text'] as const) {
          const open = this[part];
          if (open && open.buf.length > 0) {
            open.buf = '';
            steps.push({ op: 'reset', seg: open.seg, part });
          }
        }
        return steps;
      }
      case 'done':
      case 'error':
        return this.flush();
      default:
        return [];
    }
  }

  /** Seal every open segment (thinking first: it precedes text in a round). */
  flush(): SegmentStep[] {
    return [...this.seal('thinking'), ...this.seal('text')];
  }

  private append(part: SegmentPart, content: string): SegmentStep[] {
    if (!content) return [];
    let open = this[part];
    if (!open) {
      open = { seg: this.next++, buf: '' };
      this[part] = open;
    }
    const offset = open.buf.length;
    open.buf += content;
    return [{ op: 'delta', seg: open.seg, part, offset, text: content }];
  }

  private message(text: string): SegmentStep[] {
    const open = this.text;
    if (open) {
      open.buf = text;
      return this.seal('text');
    }
    if (text === this.lastSealedText) return [];
    this.text = { seg: this.next++, buf: text };
    return this.seal('text');
  }

  private seal(part: SegmentPart): SegmentStep[] {
    const open = this[part];
    if (!open) return [];
    this[part] = undefined;
    const steps: SegmentStep[] = [];
    if (open.buf.trim().length > 0) {
      if (part === 'text') {
        this.lastSealedText = open.buf;
        steps.push({ op: 'record', payload: { kind: 'assistant', seg: open.seg, text: clip(open.buf, MAX_ASSISTANT_TEXT_LEN) } });
      } else {
        steps.push({ op: 'record', payload: { kind: 'thinking', seg: open.seg, text: clip(open.buf, MAX_TEXT_LEN) } });
      }
    }
    steps.push({ op: 'seal', seg: open.seg, part });
    return steps;
  }
}
