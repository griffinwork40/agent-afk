/**
 * Tests for stream-renderer-lifecycle helpers.
 *
 * Focused on the pure, context-free pieces — the interrupt affordance render
 * contract. The full registerOverlaySlots wiring is exercised via the
 * StreamRenderer + OverlayComposer integration tests.
 */

import { describe, it, expect } from 'vitest';
import { formatInterruptAffordance, registerOverlaySlots } from './stream-renderer-lifecycle.js';
import { OverlayComposer } from './overlay-composer.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { stripAnsi } from '../display.js';

describe('formatInterruptAffordance', () => {
  it('returns an empty string when not interrupting (slot occupies no space)', () => {
    expect(formatInterruptAffordance(false)).toBe('');
  });

  it('renders the interrupt affordance + exit hint when interrupting', () => {
    const out = stripAnsi(formatInterruptAffordance(true));
    expect(out).toMatch(/interrupting/i);
    expect(out).toMatch(/Ctrl\+C again/i);
  });
});

describe('registerOverlaySlots — thinking-live slot', () => {
  // Build a composer whose only active producer is the thinking-live slot:
  // every other slot is stubbed to render '' so the composed overlay is the
  // thinking preview alone (or '' when the slot is suppressed).
  function makeComposer(thinkingLane: ThinkingLane): { captured: string[]; composer: OverlayComposer } {
    const captured: string[] = [];
    const composer = new OverlayComposer({ setOverlay: (t) => captured.push(t) }, [
      'thinking-live',
      'markdown-pending',
      'tool-lane',
      'progress-banner',
      'stage-rail',
      'interrupt',
    ]);
    registerOverlaySlots(composer, {
      stageTracker: undefined,
      thinkingMode: 'live',
      thinkingLane,
      streamingMarkdownRef: { current: null },
      toolLane: { hasPending: () => false, getOverlay: () => '' },
      lastProgressByTask: new Map(),
      getInterrupting: () => false,
    } as unknown as Parameters<typeof registerOverlaySlots>[1]);
    return { captured, composer };
  }

  it('renders the live preview while thinking is active, then stops after collapse', () => {
    const thinkingLane = new ThinkingLane();
    const { captured, composer } = makeComposer(thinkingLane);

    // While thinking streams, the preview is composed into the overlay.
    thinkingLane.push('weighing the tradeoffs of the two approaches');
    composer.invalidate();
    composer.flush();
    expect(stripAnsi(captured.at(-1) ?? '')).toContain('thinking');
    expect(stripAnsi(captured.at(-1) ?? '')).toContain('tradeoffs');

    // After collapse (the "thought for Xs" summary is committed above), the
    // live preview must vanish — even though the buffer is INTENTIONALLY
    // retained (hasBufferedContent() stays true so inlineSummary can read it).
    // Regression for the stale-thinking-in-idle-overlay leak: gating on
    // hasBufferedContent() alone left this content painted between turns.
    thinkingLane.collapse();
    expect(thinkingLane.hasBufferedContent()).toBe(true);
    expect(thinkingLane.isActive()).toBe(false);
    composer.invalidate();
    composer.flush();
    expect(captured.at(-1)).toBe('');
  });
});
