/**
 * End-to-end proof that the 8s-30s span of the live-progress dead zone is
 * closed (#857). The full dead zone runs ~1.5s-30s; the banner clause is gated
 * on CHILD_QUIET_MS (8s), so this covers 8s onward, not the whole window.
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
import { StreamRenderer } from './stream-renderer.js';
import type { Writer } from '../slash/types.js';
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

    // Capturing tool-lane so the sibling checkPauseAnnotations can be driven
    // in the combined-tick case below, not just observed staying dormant.
    const laneCalls: string[] = [];
    const ctx = {
      disposed: false,
      isTTY: true,
      sources,
      overlayComposer: composer,
      compositor: null,
      stageTracker: undefined,
      thinkingLane: new ThinkingLane(),
      toolLane: {
        hasPending: () => false,
        getOverlay: () => '',
        addStartWithAgentContext: (_id: string, _kind: string, label: string) =>
          laneCalls.push(label),
        addResult: () => {},
      },
      streamingMarkdownRef: { current: null },
      lastProgressByTask: new Map(),
      thinkingMode: 'summary' as const,
      out: { write: () => {} },
      pauseTickInterval: null,
      resizeUnsub: null,
    } as unknown as Parameters<typeof checkProgressBannerStaleness>[0];

    const overlay = (): string => stripAnsi(captured.at(-1) ?? '');
    const flushCount = (): number => captured.length;
    return { composer, ctx, overlay, laneCalls, flushCount };
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

  it('keeps banner latch and 30s lane annotation independent when both fire on one tick', () => {
    // Past 30s BOTH checkers are live on the same 80ms tick: the dead-zone
    // banner latch and the tool-lane stall annotation. They own separate slots
    // and separate state, so neither may suppress or clobber the other.
    const child = freshSourceState('reviewer');
    child.lastProgressSummary = 'round 2: bash pnpm test';
    child.syntheticAgentToolUseId = 'tool-1';
    child.lastEventAt = Date.now() - 40_000;
    const sources = new Map([['child-1', child]]);

    const { ctx, overlay, laneCalls } = harness(sources);

    // Banner half: latches and paints the static clause.
    expect(checkProgressBannerStaleness(ctx)).toBe(true);
    expect(overlay()).toContain('no output (waiting)');

    // Lane half, same tick: the 30s annotation now DOES arm (contrast with the
    // ~10s case above, where it must stay dormant).
    expect(checkPauseAnnotations(ctx)).toBe(true);
    expect(child.pauseAnnotation).toMatch(/ · waiting /);
    expect(laneCalls.some((l) => l.includes('waiting'))).toBe(true);

    // Neither clobbered the other: the banner clause survives the tool-lane
    // flush, and the banner latch is still held so the next tick is quiet.
    expect(overlay()).toContain('no output (waiting)');
    expect(checkProgressBannerStaleness(ctx)).toBe(false);
  });
});

describe('dead-zone latch re-arms at the activity site, not on a later tick', () => {
  // Regression for the codex P2 on #874. The latch used to be cleared ONLY by
  // checkProgressBannerStaleness observing an intermediate fresh state, which
  // requires some tick to land inside the 8s window after a child resumes. A
  // suspended process, a closed lid, or an event loop blocked past 8s skips
  // every such tick, stranding the latch at true — and the next real quiet
  // transition is then swallowed by the `already announced` guard, reopening
  // the dead zone for that child permanently. So the clear must happen
  // synchronously where activity is recorded. This test runs NO tick at all
  // between the activity and the assertion, which is the whole point.
  function sink(): Writer {
    const noop = (): void => {};
    return { line: noop, raw: noop, success: noop, info: noop, warn: noop, error: noop };
  }

  it('clears quietBannerAnnounced on child activity with no intervening tick', () => {
    const r = new StreamRenderer({ out: sink(), forceNonTty: true });
    const progress = {
      type: 'progress' as const,
      progress: { taskId: 't', description: 'd', totalTokens: 0, toolUses: 1, durationMs: 0 },
    };
    r.process(progress, { subagentId: 'child-1', agentType: 'reviewer' });

    const sources = (r as unknown as { sources: Map<string, SourceState> }).sources;
    const child = sources.get('child-1');
    expect(child).toBeDefined();
    if (!child) return;

    // Simulate the state left behind after a quiet transition was announced
    // and the process was then suspended past the whole fresh window.
    child.quietBannerAnnounced = true;
    child.lastEventAt = Date.now() - 60_000;

    // One real activity event — and nothing else. No pause tick runs here.
    r.process(progress, { subagentId: 'child-1', agentType: 'reviewer' });

    expect(child.quietBannerAnnounced).toBe(false);
    r.dispose();
  });
});
