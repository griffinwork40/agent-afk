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
import { ChildActivityTracker } from './child-activity-select.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import type { ProgressEvent } from '../../agent/types.js';

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
      getSoftStopping: () => false,
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

describe('registerOverlaySlots — progress-banner stopping wiring', () => {
  // Build a composer whose only active producer is the progress-banner slot.
  // `getSoftStopping` and the progress map are caller-controlled so we can
  // assert the slot flips to the stopping banner when the accessor returns true
  // — this is the wiring seam between the ESC handler and the banner render.
  function makeComposer(
    lastProgressByTask: Map<string, ProgressEvent>,
    getSoftStopping: () => boolean,
  ): { captured: string[]; composer: OverlayComposer } {
    const captured: string[] = [];
    const composer = new OverlayComposer({ setOverlay: (t) => captured.push(t) }, [
      'thinking-live',
      'markdown-pending',
      'tool-lane',
      'progress-banner',
      'interrupt',
    ]);
    registerOverlaySlots(composer, {
      stageTracker: undefined,
      thinkingMode: 'summary',
      thinkingLane: new ThinkingLane(),
      streamingMarkdownRef: { current: null },
      toolLane: { hasPending: () => false, getOverlay: () => '' },
      lastProgressByTask,
      getInterrupting: () => false,
      getSoftStopping,
    } as unknown as Parameters<typeof registerOverlaySlots>[1]);
    return { captured, composer };
  }

  const mkProgress = (): ProgressEvent => ({
    taskId: 't1',
    description: 'Tool-use loop',
    summary: 'round 3: bash ls',
    lastToolName: 'Bash',
    totalTokens: 1200,
    toolUses: 5,
    durationMs: 4500,
  });

  it('does NOT show the stopping indicator during normal streaming', () => {
    const progress = new Map([['t1', mkProgress()]]);
    const { captured, composer } = makeComposer(progress, () => false);
    composer.invalidate();
    composer.flush();
    const overlay = stripAnsi(captured.at(-1) ?? '');
    expect(overlay).toContain('Tool-use loop');
    expect(overlay).not.toContain('stopping…');
    // Normal streaming keeps the tool clause (the "what it's doing" signal).
    // NB: the composed overlay is clamped to the test terminal width, so the
    // trailing `esc to interrupt` hint can be truncated — the full-width hint
    // contract lives in progress-banner.test.ts. Here we assert the negative
    // (no stopping clause) plus that the live activity/tool clause survives.
    expect(overlay).toContain('via');
  });

  it('flips the banner to the stopping state when getSoftStopping() is true', () => {
    const progress = new Map([['t1', mkProgress()]]);
    let stopping = false;
    const { captured, composer } = makeComposer(progress, () => stopping);

    composer.invalidate();
    composer.flush();
    expect(stripAnsi(captured.at(-1) ?? '')).not.toContain('stopping…');

    // ESC handled → the accessor now reports stopping. Next recompose paints it.
    stopping = true;
    composer.markDirty('progress-banner');
    composer.flush();
    const overlay = stripAnsi(captured.at(-1) ?? '');
    expect(overlay).toContain('stopping…');
    // The stale tool/activity clause is replaced by the stopping indicator.
    expect(overlay).not.toContain('round 3: bash ls');
  });

  it('synthesizes a stopping banner even when no progress event is live (text-only turn)', () => {
    // A text-only turn never emits a `progress` event, so lastProgressByTask is
    // empty — but ESC must still give visible feedback.
    const { captured, composer } = makeComposer(new Map(), () => true);
    composer.invalidate();
    composer.flush();
    expect(stripAnsi(captured.at(-1) ?? '')).toContain('stopping…');
  });

  it('renders no banner at all when idle (no progress, not stopping)', () => {
    const { captured, composer } = makeComposer(new Map(), () => false);
    composer.invalidate();
    composer.flush();
    expect(captured.at(-1)).toBe('');
  });
});

describe('registerOverlaySlots — child banner without a parent progress row', () => {
  // Regression for PR #840 review (P1). Both provider loops emit the parent's
  // `progress` event AFTER the round's tools are dispatched and their results
  // committed, so a foreground subagent launched in the parent's FIRST tool
  // round runs its whole life while lastProgressByTask is still empty. The
  // per-task render loop then iterates zero times and the child banner — which
  // was computed — is discarded, leaving the banner blank for exactly the case
  // the feature exists to cover.
  function makeComposer(
    lastProgressByTask: Map<string, ProgressEvent>,
    sources: Map<string, SourceState>,
    getSoftStopping: () => boolean = () => false,
  ): { captured: string[]; composer: OverlayComposer } {
    const captured: string[] = [];
    const composer = new OverlayComposer({ setOverlay: (t) => captured.push(t) }, [
      'thinking-live',
      'markdown-pending',
      'tool-lane',
      'progress-banner',
      'interrupt',
    ]);
    registerOverlaySlots(composer, {
      stageTracker: undefined,
      thinkingMode: 'summary',
      thinkingLane: new ThinkingLane(),
      streamingMarkdownRef: { current: null },
      toolLane: { hasPending: () => false, getOverlay: () => '' },
      lastProgressByTask,
      getInterrupting: () => false,
      getSoftStopping,
      sources,
      childActivity: new ChildActivityTracker(),
    } as unknown as Parameters<typeof registerOverlaySlots>[1]);
    return { captured, composer };
  }

  function liveChild(agentType: string): Map<string, SourceState> {
    const source = freshSourceState(agentType);
    source.lastProgressSummary = 'round 3: bash pnpm test';
    source.stats.tokens = 2400;
    source.stats.toolUses = 7;
    return new Map([['child-1', source]]);
  }

  it('paints the child clause when lastProgressByTask is empty', () => {
    const { captured, composer } = makeComposer(new Map(), liveChild('reviewer'));
    composer.invalidate();
    composer.flush();
    const overlay = stripAnsi(captured.at(-1) ?? '');
    expect(overlay).toContain('reviewer');
    expect(overlay).toContain('round 3: bash pnpm test');
  });

  it('carries the child-scoped stats on that synthesized row', () => {
    const { captured, composer } = makeComposer(new Map(), liveChild('reviewer'));
    composer.invalidate();
    composer.flush();
    const overlay = stripAnsi(captured.at(-1) ?? '');
    // 7 tool calls from the CHILD's SourceState — not the parent's counters,
    // which is the contradiction the child-scoped stats exist to remove.
    expect(overlay).toMatch(/7 tool calls/);
  });

  it('still yields the soft-stop banner when stopping, not the child clause', () => {
    // Precedence: ESC feedback outranks the child fallback. Both branches fire
    // only on an empty per-task loop, so this pins the order between them.
    const { captured, composer } = makeComposer(new Map(), liveChild('reviewer'), () => true);
    composer.invalidate();
    composer.flush();
    const overlay = stripAnsi(captured.at(-1) ?? '');
    expect(overlay).toContain('stopping…');
    expect(overlay).not.toContain('round 3: bash pnpm test');
  });

  it('leaves the banner blank when no child is live', () => {
    const { captured, composer } = makeComposer(new Map(), new Map());
    composer.invalidate();
    composer.flush();
    expect(captured.at(-1)).toBe('');
  });
});
