/**
 * Tests for the dead-zone checker (stream-renderer-dead-zone.ts).
 *
 * Covers the per-source quiet latch: one flush per transition into silence,
 * re-armed when the child speaks again — not a flush on every 80ms tick.
 */

import { describe, it, expect } from 'vitest';
import { checkProgressBannerStaleness } from './stream-renderer-dead-zone.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import { CHILD_QUIET_MS } from './child-activity-select.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';

describe('checkProgressBannerStaleness', () => {
  function makeCtx(over: Partial<Parameters<typeof checkProgressBannerStaleness>[0]> = {}) {
    const marks: string[] = [];
    const flushes: number[] = [];
    const overlayComposer = {
      markDirty: (key: string) => marks.push(key),
      flush: () => flushes.push(flushes.length),
    };
    return {
      ctx: {
        disposed: false,
        isTTY: true,
        sources: new Map<string, SourceState>(),
        overlayComposer,
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
        ...over,
      },
      marks,
      flushes,
    };
  }

  it('marks progress-banner dirty when a running child is silent past CHILD_QUIET_MS', () => {
    const { ctx, marks, flushes } = makeCtx({
      sources: new Map([
        ['child-1', freshSourceState('reviewer')],
      ]),
    });
    // Set child to be silent for 10s (> CHILD_QUIET_MS = 8s)
    ctx.sources.get('child-1')!.lastEventAt = Date.now() - 10_000;
    const changed = checkProgressBannerStaleness(ctx);
    expect(changed).toBe(true);
    expect(marks).toContain('progress-banner');
    expect(flushes.length).toBe(1);
  });

  it('does NOT mark dirty when all children are fresh (under CHILD_QUIET_MS)', () => {
    const { ctx, marks, flushes } = makeCtx({
      sources: new Map([
        ['child-1', freshSourceState('reviewer')],
      ]),
    });
    ctx.sources.get('child-1')!.lastEventAt = Date.now() - 3_000;
    const changed = checkProgressBannerStaleness(ctx);
    expect(changed).toBe(false);
    expect(marks.length).toBe(0);
    expect(flushes.length).toBe(0);
  });

  it('skips the orchestrator source', () => {
    const { ctx, marks } = makeCtx({
      sources: new Map([
        ['__main__', freshSourceState(undefined)],
      ]),
    });
    ctx.sources.get('__main__')!.lastEventAt = Date.now() - 50_000;
    const changed = checkProgressBannerStaleness(ctx);
    expect(changed).toBe(false);
    expect(marks.length).toBe(0);
  });

  it('skips done and errored sources', () => {
    const { ctx, marks } = makeCtx({
      sources: new Map([
        ['child-1', { ...freshSourceState('reviewer'), done: true }],
        ['child-2', { ...freshSourceState('reviewer'), errored: true }],
      ]),
    });
    ctx.sources.get('child-1')!.lastEventAt = Date.now() - 50_000;
    ctx.sources.get('child-2')!.lastEventAt = Date.now() - 50_000;
    const changed = checkProgressBannerStaleness(ctx);
    expect(changed).toBe(false);
    expect(marks.length).toBe(0);
  });

  it('returns false when disposed', () => {
    const { ctx, marks } = makeCtx({ disposed: true });
    ctx.sources.set('child-1', freshSourceState('reviewer'));
    ctx.sources.get('child-1')!.lastEventAt = Date.now() - 50_000;
    expect(checkProgressBannerStaleness(ctx)).toBe(false);
    expect(marks.length).toBe(0);
  });

  it('returns false on non-TTY surfaces', () => {
    const { ctx, marks } = makeCtx({ isTTY: false });
    ctx.sources.set('child-1', freshSourceState('reviewer'));
    ctx.sources.get('child-1')!.lastEventAt = Date.now() - 50_000;
    expect(checkProgressBannerStaleness(ctx)).toBe(false);
    expect(marks.length).toBe(0);
  });

  it('marks dirty for ANY silent child in a multi-child fleet', () => {
    const { ctx, marks } = makeCtx({
      sources: new Map([
        ['child-1', freshSourceState('reviewer')],
        ['child-2', freshSourceState('pragmatist')],
      ]),
    });
    // child-1 is fresh, child-2 is silent
    ctx.sources.get('child-1')!.lastEventAt = Date.now() - 1_000;
    ctx.sources.get('child-2')!.lastEventAt = Date.now() - 12_000;
    const changed = checkProgressBannerStaleness(ctx);
    expect(changed).toBe(true);
    expect(marks).toContain('progress-banner');
  });

  it('trips at exactly CHILD_QUIET_MS silence (>=, not >)', () => {
    const { ctx, marks, flushes } = makeCtx({
      sources: new Map([
        ['child-1', freshSourceState('reviewer')],
      ]),
    });
    ctx.sources.get('child-1')!.lastEventAt = Date.now() - CHILD_QUIET_MS;
    const changed = checkProgressBannerStaleness(ctx);
    expect(changed).toBe(true);
    expect(marks).toContain('progress-banner');
    expect(flushes.length).toBe(1);
  });

  it('latches: a second consecutive tick on the same still-quiet child does not re-flush', () => {
    const { ctx, flushes } = makeCtx({
      sources: new Map([
        ['child-1', freshSourceState('reviewer')],
      ]),
    });
    ctx.sources.get('child-1')!.lastEventAt = Date.now() - 10_000;
    const first = checkProgressBannerStaleness(ctx);
    expect(first).toBe(true);
    expect(flushes.length).toBe(1);
    const second = checkProgressBannerStaleness(ctx);
    expect(second).toBe(false);
    expect(flushes.length).toBe(1);
  });

  it('re-announces later silence after the child speaks again in between', () => {
    const { ctx, flushes } = makeCtx({
      sources: new Map([
        ['child-1', freshSourceState('reviewer')],
      ]),
    });
    const source = ctx.sources.get('child-1')!;

    // Phase 1: silent past threshold -> transitions and flushes once.
    source.lastEventAt = Date.now() - 10_000;
    expect(checkProgressBannerStaleness(ctx)).toBe(true);
    expect(flushes.length).toBe(1);

    // Phase 2: child speaks again -> latch clears, no new flush.
    source.lastEventAt = Date.now();
    expect(checkProgressBannerStaleness(ctx)).toBe(false);
    expect(flushes.length).toBe(1);
    expect(source.quietBannerAnnounced).toBe(false);

    // Phase 3: pushed back past threshold -> re-announces with a second flush.
    source.lastEventAt = Date.now() - CHILD_QUIET_MS - 1000;
    expect(checkProgressBannerStaleness(ctx)).toBe(true);
    expect(flushes.length).toBe(2);
  });
});
