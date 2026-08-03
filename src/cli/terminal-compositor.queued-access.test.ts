/**
 * Tests for out-of-band typed-ahead queue access (Ctrl+B flush support).
 *
 * Two invariants carry the weight here: peek must never mutate (promotion can
 * fail, and the message must survive that), and drop must clear the post-ESC
 * coalesce bookkeeping — a non-null `postEscPayload` absent from the queue is
 * the dangling reference that makes the next post-ESC Enter throw.
 */

import { describe, it, expect, vi } from 'vitest';
import { peekQueuedText, dropQueued, type QueuedAccessHost } from './terminal-compositor.queued-access.js';
import type { SubmissionPayload } from './terminal-compositor.types.js';

const payload = (text: string, attachments: SubmissionPayload['attachments'] = []): SubmissionPayload => ({
  text,
  attachments,
});

function host(pending: SubmissionPayload[]): QueuedAccessHost & { repaint: ReturnType<typeof vi.fn> } {
  return {
    pendingSubmissions: pending,
    queued: pending.length > 0,
    postEscCoalesce: false,
    postEscPayload: null,
    repaint: vi.fn(),
  };
}

describe('peekQueuedText', () => {
  it('returns undefined when nothing is queued', () => {
    expect(peekQueuedText(host([]))).toBeUndefined();
  });

  it('returns the single queued message', () => {
    expect(peekQueuedText(host([payload('check the tests')]))).toBe('check the tests');
  });

  it('coalesces multiple queued messages in FIFO order, newline-joined', () => {
    const h = host([payload('first'), payload('second'), payload('third')]);
    expect(peekQueuedText(h)).toBe('first\nsecond\nthird');
  });

  it('does NOT mutate the queue — promotion may still fail', () => {
    const h = host([payload('a'), payload('b')]);
    peekQueuedText(h);
    expect(h.pendingSubmissions).toHaveLength(2);
    expect(h.queued).toBe(true);
  });

  it('returns undefined when any payload carries attachments (must drain as its own turn)', () => {
    // A tool_result content string cannot carry image blocks, so flushing would
    // silently drop the user's images. Bail out instead.
    const withImage = payload('look at this', [
      { kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' } as never,
    ]);
    expect(peekQueuedText(host([payload('text only'), withImage]))).toBeUndefined();
  });

  it('returns undefined for a whitespace-only queue', () => {
    expect(peekQueuedText(host([payload('  '), payload('\n')]))).toBeUndefined();
  });
});

describe('dropQueued', () => {
  it('is a no-op returning 0 on an empty queue', () => {
    const h = host([]);
    expect(dropQueued(h)).toBe(0);
    expect(h.repaint).not.toHaveBeenCalled();
  });

  it('removes every payload and maintains the `queued` mirror', () => {
    const h = host([payload('a'), payload('b')]);
    expect(dropQueued(h)).toBe(2);
    expect(h.pendingSubmissions).toHaveLength(0);
    expect(h.queued).toBe(false);
    expect(h.repaint).toHaveBeenCalled();
  });

  it('clears the post-ESC coalesce epoch (drain semantics, not recall semantics)', () => {
    // The flushed text is now bound for a RUNNING turn, so the epoch is over —
    // matching the `→ idle` drain, not the ↑-recall pop which leaves it armed.
    const tracked = payload('post-esc redirect');
    const h = host([tracked]);
    h.postEscCoalesce = true;
    h.postEscPayload = tracked;

    dropQueued(h);

    expect(h.postEscCoalesce).toBe(false);
    expect(h.postEscPayload).toBeNull();
  });

  it('never leaves a dangling postEscPayload reference', () => {
    const tracked = payload('tracked');
    const h = host([payload('other'), tracked]);
    h.postEscCoalesce = true;
    h.postEscPayload = tracked;

    dropQueued(h);

    // The invariant the input-dispatch coalesce block asserts: a non-null
    // reference must be PRESENT in the queue. Null satisfies it vacuously.
    const dangling = h.postEscPayload !== null && !h.pendingSubmissions.includes(h.postEscPayload);
    expect(dangling).toBe(false);
  });

  it('a second drop after a flush returns 0 — no double-delivery', () => {
    const h = host([payload('once')]);
    expect(dropQueued(h)).toBe(1);
    expect(dropQueued(h)).toBe(0);
  });
});
