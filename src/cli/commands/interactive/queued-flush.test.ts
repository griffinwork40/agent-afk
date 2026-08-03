/**
 * Tests for the Ctrl+B queued-message flush: peek → pass → confirm → drain.
 *
 * The load-bearing case is the NEGATIVE one. Promotion legitimately fails (no
 * background registry wired, or the background-job cap was hit and the subagent
 * stayed foreground), and in that case there is no promotion tool_result for the
 * text to ride. A drain-then-promote implementation eats the user's message
 * there; this one must leave it queued.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  promoteWithQueuedFlush,
  previewOneLine,
  type QueuedFlushCompositor,
  type QueuedFlushControl,
} from './queued-flush.js';

type Claim = { readonly text: string; claimed: boolean };

function compositor(queuedText: string | undefined): QueuedFlushCompositor & {
  dropQueued: ReturnType<typeof vi.fn>;
} {
  return {
    peekQueuedText: () => queuedText,
    dropQueued: vi.fn(() => 1),
  };
}

/** Control seam whose promotion either claims the note or does not. */
function control(opts: {
  jobs: { jobId: string; label: string }[];
  /** Simulates the agent layer folding the note into a promotion tool_result. */
  claims: boolean;
}): QueuedFlushControl & { seen: Claim | undefined } {
  const c: QueuedFlushControl & { seen: Claim | undefined } = {
    seen: undefined,
    hasPromotableForeground: () => true,
    promoteActiveForeground: async (note) => {
      c.seen = note;
      if (opts.claims && note !== undefined) note.claimed = true;
      return opts.jobs;
    },
  };
  return c;
}

const oneJob = [{ jobId: 'bg-1', label: 'deep investigation' }];

describe('promoteWithQueuedFlush', () => {
  it('passes the queued text to promotion and drains it once delivery is confirmed', async () => {
    const comp = compositor('actually check the tests first');
    const ctrl = control({ jobs: oneJob, claims: true });

    const out = await promoteWithQueuedFlush(ctrl, comp);

    expect(ctrl.seen?.text).toBe('actually check the tests first');
    expect(out.flushedText).toBe('actually check the tests first');
    expect(out.jobs).toEqual(oneJob);
    expect(comp.dropQueued).toHaveBeenCalledTimes(1);
  });

  it('does NOT drain when promotion did not claim the note (cap hit / no registry)', async () => {
    // The subagent stayed foreground: no promotion tool_result exists, so the
    // message has nowhere to ride and must survive for the next-turn drain.
    const comp = compositor('do not lose me');
    const ctrl = control({ jobs: [], claims: false });

    const out = await promoteWithQueuedFlush(ctrl, comp);

    expect(out.flushedText).toBeUndefined();
    expect(comp.dropQueued).not.toHaveBeenCalled();
  });

  it('does NOT drain when a job was promoted but the note went unclaimed', async () => {
    // Defensive: delivery is gated on the claim, never inferred from job count.
    const comp = compositor('still queued');
    const ctrl = control({ jobs: oneJob, claims: false });

    const out = await promoteWithQueuedFlush(ctrl, comp);

    expect(out.jobs).toEqual(oneJob);
    expect(out.flushedText).toBeUndefined();
    expect(comp.dropQueued).not.toHaveBeenCalled();
  });

  it('promotes normally with no queued message (no ticket is created)', async () => {
    const comp = compositor(undefined);
    const ctrl = control({ jobs: oneJob, claims: true });

    const out = await promoteWithQueuedFlush(ctrl, comp);

    expect(ctrl.seen).toBeUndefined();
    expect(out.flushedText).toBeUndefined();
    expect(comp.dropQueued).not.toHaveBeenCalled();
  });

  it('works with no compositor at all (non-TTY surfaces keep old behavior)', async () => {
    const ctrl = control({ jobs: oneJob, claims: true });
    const out = await promoteWithQueuedFlush(ctrl, null);
    expect(out.jobs).toEqual(oneJob);
    expect(out.flushedText).toBeUndefined();
    expect(ctrl.seen).toBeUndefined();
  });

  it('peeks before promoting, and drops strictly after (ordering)', async () => {
    const order: string[] = [];
    const comp: QueuedFlushCompositor = {
      peekQueuedText: () => {
        order.push('peek');
        return 'text';
      },
      dropQueued: () => {
        order.push('drop');
        return 1;
      },
    };
    const ctrl: QueuedFlushControl = {
      hasPromotableForeground: () => true,
      promoteActiveForeground: async (note) => {
        order.push('promote');
        if (note) note.claimed = true;
        return oneJob;
      },
    };

    await promoteWithQueuedFlush(ctrl, comp);
    expect(order).toEqual(['peek', 'promote', 'drop']);
  });
});

describe('previewOneLine', () => {
  it('collapses whitespace to a single line', () => {
    expect(previewOneLine('check\nthe   tests\tfirst')).toBe('check the tests first');
  });

  it('truncates long text with an ellipsis', () => {
    const out = previewOneLine('y'.repeat(200));
    expect(out).toHaveLength(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves short text intact', () => {
    expect(previewOneLine('  short  ')).toBe('short');
  });
});
