import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import {
  applyFirstContent,
  checkTtfbAnnotation,
  type TtfbTickCtx,
} from './stream-renderer-ttfb.js';
import type { OverlayComposer } from './overlay-composer.js';
import type { Writer } from '../slash/types.js';

const writer: Writer = {
  line: vi.fn(),
  raw: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── applyFirstContent ───────────────────────────────────────────────────────

describe('applyFirstContent', () => {
  it('marks the banner without flushing synchronously and is idempotent', () => {
    const composer = {
      markDirty: vi.fn(),
      flush: vi.fn(),
    } as unknown as OverlayComposer;
    const setDone = vi.fn();

    expect(applyFirstContent(false, setDone, composer)).toBe(true);
    expect(setDone).toHaveBeenCalledOnce();
    expect(composer.markDirty).toHaveBeenCalledWith('progress-banner');
    expect(composer.flush).not.toHaveBeenCalled();

    expect(applyFirstContent(true, setDone, composer)).toBe(false);
    expect(setDone).toHaveBeenCalledOnce();
    expect(composer.markDirty).toHaveBeenCalledOnce();
  });
});

// ─── checkTtfbAnnotation ─────────────────────────────────────────────────────

describe('checkTtfbAnnotation — marks dirty on each second advance', () => {
  function makeCtx(overrides?: Partial<TtfbTickCtx>): TtfbTickCtx {
    return {
      ttfbStartedAt: Date.now() - 3_000, // 3s ago → past grace period
      ttfbDone: false,
      lastTtfbAnnotation: '',
      isTTY: true,
      disposed: false,
      overlayComposer: {
        markDirty: vi.fn(),
        flush: vi.fn(),
      } as unknown as OverlayComposer,
      ...overrides,
    };
  }

  it('returns false when inside grace period', () => {
    const ctx = makeCtx({ ttfbStartedAt: Date.now() - 500 });
    const fired = checkTtfbAnnotation(ctx, Date.now());
    expect(fired).toBe(false);
  });

  it('returns true on the first tick past the grace period', () => {
    const ctx = makeCtx();
    const fired = checkTtfbAnnotation(ctx, Date.now());
    expect(fired).toBe(true);
  });

  it('does NOT fire again on a repeat tick within the same second', () => {
    const ctx = makeCtx();
    checkTtfbAnnotation(ctx, Date.now());
    // Second call with same timestamp → same second → no change
    const fired = checkTtfbAnnotation(ctx, Date.now());
    expect(fired).toBe(false);
  });

  it('fires on each new second', () => {
    const now = Date.now();
    const ctx = makeCtx({ ttfbStartedAt: now - 3_000 });
    expect(checkTtfbAnnotation(ctx, now)).toBe(true); // 3s
    expect(checkTtfbAnnotation(ctx, now + 1_000)).toBe(true); // 4s
    expect(checkTtfbAnnotation(ctx, now + 2_000)).toBe(true); // 5s
  });

  it('returns false when ttfbDone is true', () => {
    const ctx = makeCtx({ ttfbDone: true });
    expect(checkTtfbAnnotation(ctx, Date.now())).toBe(false);
  });

  it('returns false when disposed', () => {
    const ctx = makeCtx({ disposed: true });
    expect(checkTtfbAnnotation(ctx, Date.now())).toBe(false);
  });
});


// ─── StreamRenderer integration ──────────────────────────────────────────────

describe('StreamRenderer.notifyFirstContent', () => {
  it('guarantees one post-notification flush in a later event-loop turn', () => {
    vi.useFakeTimers();
    const renderer = new StreamRenderer({
      out: writer,
      forceNonTty: true,
      turnStartedAt: Date.now(),
    });
    const composer = {
      markDirty: vi.fn(),
      flush: vi.fn(),
    } as unknown as OverlayComposer;
    const privateRenderer = renderer as unknown as {
      overlayComposer: OverlayComposer;
      ttfbDone: boolean;
    };
    privateRenderer.overlayComposer = composer;

    renderer.notifyFirstContent();
    expect(privateRenderer.ttfbDone).toBe(true);
    expect(composer.markDirty).toHaveBeenCalledWith('progress-banner');
    expect(composer.flush).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();
    expect(composer.flush).toHaveBeenCalledOnce();

    renderer.notifyFirstContent();
    vi.runOnlyPendingTimers();
    expect(composer.flush).toHaveBeenCalledOnce();
  });
});

