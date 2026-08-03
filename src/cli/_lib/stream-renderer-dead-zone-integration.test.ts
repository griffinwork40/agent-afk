/**
 * End-to-end proof that the 1.5s–30s live-progress dead zone is closed (#857).
 *
 * The two halves of the fix had only ever been unit-tested in isolation: the
 * staleness checker (does it mark the slot dirty?) and the child-activity
 * selector (does it emit the static clause?). Nothing joined them, so nothing
 * actually proved an operator sees `no output (waiting)` during the dead zone.
 *
 * This test drives a REAL OverlayComposer through registerOverlaySlots and
 * asserts on the composed banner text, plus the negative half: the tool-lane's
 * `· waiting Xs` annotation must NOT have armed yet at ~10s — it arms only past
 * PAUSE_THRESHOLD_MS (30s). That contrast is what makes this a dead-zone test
 * rather than a generic banner test.
 */

import { describe, it, expect } from 'vitest';
import { OverlayComposer } from './overlay-composer.js';
import { registerOverlaySlots, checkPauseAnnotations } from './stream-renderer-lifecycle.js';
import { checkProgressBannerStaleness } from './stream-renderer-dead-zone.js';
import { CHILD_QUIET_MS, ChildActivityTracker } from './child-activity-select.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { stripAnsi } from '../display.js';

describe('dead-zone integration: checkProgressBannerStaleness -> registered progress-banner slot', () => {
  function harness(sources: Map<string, SourceState>) {
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
      lastProgressByTask: new Map(),
      getInterrupting: () => false,
      getSoftStopping: () => false,
      sources,
      childActivity: new ChildActivityTracker(),
    } as unknown as Parameters<typeof registerOverlaySlots>[1]);

    const ctx = {
      disposed: false,
      isTTY: true,
      sources,
      overlayComposer: composer,
      compositor: null,
      stageTracker: undefined,
      thinkingLane: new ThinkingLane(),
      toolLane: { hasPending: () => false, getOverlay: () => '' },
      streamingMarkdownRef: { current: null },
      lastProgressByTask: new Map(),
      thinkingMode: 'summary' as const,
      out: { write: () => {} },
      pauseTickInterval: null,
      resizeUnsub: null,
    } as unknown as Parameters<typeof checkProgressBannerStaleness>[0];

    const overlay = (): string => stripAnsi(captured.at(-1) ?? '');
    return { composer, ctx, overlay };
  }

  it('paints `no output (waiting)` once the child crosses CHILD_QUIET_MS, before the 30s lane annotation arms', () => {
    const child = freshSourceState('reviewer');
    child.lastProgressSummary = 'round 2: bash pnpm test';
    child.stats.tokens = 2400;
    child.stats.toolUses = 7;
    // Required for the negative half below: checkPauseAnnotations skips any
    // source without a synthetic Agent toolUseId, which would make the
    // "annotation has not armed" assertion vacuously true.
    child.syntheticAgentToolUseId = 'tool-1';
    child.lastEventAt = Date.now();
    const sources = new Map([['child-1', child]]);

    const { composer, ctx, overlay } = harness(sources);

    // Baseline: child is live and talking — the working clause shows, the
    // silence clause does not.
    composer.invalidate();
    composer.flush();
    expect(overlay()).toContain('round 2: bash pnpm test');
    expect(overlay()).not.toContain('no output (waiting)');

    // The dead zone opens: the child goes silent past the quiet threshold but
    // is still well short of the 30s pause threshold. No event arrives to drive
    // a recompose — the staleness checker riding the 80ms pause tick is the
    // only thing that can surface it.
    child.lastEventAt = Date.now() - CHILD_QUIET_MS - 2_000;
    expect(checkProgressBannerStaleness(ctx)).toBe(true);

    // The operator now actually sees the silent child named in the banner.
    expect(overlay()).toContain('reviewer');
    expect(overlay()).toContain('no output (waiting)');

    // Negative half: at ~10s the tool-lane's `· waiting Xs` annotation must
    // still be dormant — it arms only past PAUSE_THRESHOLD_MS (30s). If this
    // ever fires early the two mechanisms have collided.
    expect(checkPauseAnnotations(ctx)).toBe(false);
    expect(child.pauseAnnotation).toBeUndefined();
  });
});
