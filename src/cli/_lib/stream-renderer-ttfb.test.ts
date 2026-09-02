import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import {
  applyFirstContent,
  checkTtfbAnnotation,
  renderTtfbWaitingProgress,
  type TtfbTickCtx,
} from './stream-renderer-ttfb.js';
import { stripAnsi } from '../display.js';
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

// ─── checkTtfbAnnotation — spinner frame tracking ────────────────────────────

describe('checkTtfbAnnotation — spinner frame increments on each second advance', () => {
  function makeCtx(overrides?: Partial<TtfbTickCtx>): TtfbTickCtx {
    return {
      ttfbStartedAt: Date.now() - 3_000, // 3s ago → past grace period
      ttfbDone: false,
      lastTtfbAnnotation: '',
      ttfbSpinnerFrame: 0,
      isTTY: true,
      disposed: false,
      overlayComposer: {
        markDirty: vi.fn(),
        flush: vi.fn(),
      } as unknown as OverlayComposer,
      ...overrides,
    };
  }

  it('returns false and does not increment when inside grace period', () => {
    const ctx = makeCtx({ ttfbStartedAt: Date.now() - 500 });
    const fired = checkTtfbAnnotation(ctx, Date.now());
    expect(fired).toBe(false);
    expect(ctx.ttfbSpinnerFrame).toBe(0);
  });

  it('increments spinnerFrame on the first tick past the grace period', () => {
    const ctx = makeCtx();
    const fired = checkTtfbAnnotation(ctx, Date.now());
    expect(fired).toBe(true);
    expect(ctx.ttfbSpinnerFrame).toBe(1);
  });

  it('does NOT increment spinnerFrame on a repeat tick within the same second', () => {
    const ctx = makeCtx();
    checkTtfbAnnotation(ctx, Date.now());
    const frameAfterFirst = ctx.ttfbSpinnerFrame;
    // Second call with same timestamp → same second → no increment
    checkTtfbAnnotation(ctx, Date.now());
    expect(ctx.ttfbSpinnerFrame).toBe(frameAfterFirst);
  });

  it('increments spinnerFrame on each new second', () => {
    const now = Date.now();
    const ctx = makeCtx({ ttfbStartedAt: now - 3_000 });
    checkTtfbAnnotation(ctx, now); // 3s → fires
    expect(ctx.ttfbSpinnerFrame).toBe(1);
    checkTtfbAnnotation(ctx, now + 1_000); // 4s → fires
    expect(ctx.ttfbSpinnerFrame).toBe(2);
    checkTtfbAnnotation(ctx, now + 2_000); // 5s → fires
    expect(ctx.ttfbSpinnerFrame).toBe(3);
  });

  it('returns false when ttfbDone is true', () => {
    const ctx = makeCtx({ ttfbDone: true });
    expect(checkTtfbAnnotation(ctx, Date.now())).toBe(false);
    expect(ctx.ttfbSpinnerFrame).toBe(0);
  });

  it('returns false when disposed', () => {
    const ctx = makeCtx({ disposed: true });
    expect(checkTtfbAnnotation(ctx, Date.now())).toBe(false);
    expect(ctx.ttfbSpinnerFrame).toBe(0);
  });
});

// ─── renderTtfbWaitingProgress — uses streamProgress component ───────────────

describe('renderTtfbWaitingProgress', () => {
  it('returns empty string when isTtfbDone is true', () => {
    const result = renderTtfbWaitingProgress(
      () => Date.now() - 5_000,
      () => true,
      () => 0,
    );
    expect(result).toBe('');
  });

  it('returns empty string when getTtfbStartedAt is undefined', () => {
    const result = renderTtfbWaitingProgress(
      () => undefined,
      () => false,
      () => 0,
    );
    expect(result).toBe('');
  });

  it('returns empty string inside the grace period (< 2s)', () => {
    const result = renderTtfbWaitingProgress(
      () => Date.now() - 1_000, // 1s → inside 2s grace
      () => false,
      () => 0,
    );
    expect(result).toBe('');
  });

  it('returns empty string when getTtfbStartedAt is not provided', () => {
    const result = renderTtfbWaitingProgress(undefined, () => false, () => 0);
    expect(result).toBe('');
  });

  it('returns empty string when isTtfbDone is not provided', () => {
    const result = renderTtfbWaitingProgress(() => Date.now() - 5_000, undefined, () => 0);
    expect(result).toBe('');
  });

  it('renders a non-empty line past the grace period', () => {
    const result = renderTtfbWaitingProgress(
      () => Date.now() - 5_000,
      () => false,
      () => 0,
    );
    expect(result).not.toBe('');
  });

  it('contains the "Generating…" label from streamProgress', () => {
    const result = stripAnsi(
      renderTtfbWaitingProgress(
        () => Date.now() - 5_000,
        () => false,
        () => 0,
      ),
    );
    expect(result).toContain('Generating…');
  });

  it('renders a braille spinner glyph (not the legacy ◦ glyph)', () => {
    const result = stripAnsi(
      renderTtfbWaitingProgress(
        () => Date.now() - 5_000,
        () => false,
        () => 0,
      ),
    );
    // The braille glyph at frame 0 is ⠋
    expect(result).toContain('⠋');
    expect(result).not.toContain('◦');
  });

  it('advances the spinner glyph with spinnerFrame', () => {
    const at0 = stripAnsi(
      renderTtfbWaitingProgress(
        () => Date.now() - 5_000,
        () => false,
        () => 0,
      ),
    );
    const at3 = stripAnsi(
      renderTtfbWaitingProgress(
        () => Date.now() - 5_000,
        () => false,
        () => 3,
      ),
    );
    // frame 0 → ⠋, frame 3 → ⠸
    expect(at0).toContain('⠋');
    expect(at3).toContain('⠸');
    expect(at0).not.toContain('⠸');
    expect(at3).not.toContain('⠋');
  });

  it('contains the elapsed time', () => {
    const result = stripAnsi(
      renderTtfbWaitingProgress(
        () => Date.now() - 5_000,
        () => false,
        () => 0,
      ),
    );
    // formatElapsed for ~5000ms → '5s'
    expect(result).toMatch(/\d+s/);
  });

  it('defaults spinnerFrame to 0 when getSpinnerFrame is not provided', () => {
    const result = stripAnsi(
      renderTtfbWaitingProgress(
        () => Date.now() - 5_000,
        () => false,
        undefined,
      ),
    );
    // frame 0 → ⠋
    expect(result).toContain('⠋');
  });

  it('does NOT contain the old "waiting for response…" copy', () => {
    const result = stripAnsi(
      renderTtfbWaitingProgress(
        () => Date.now() - 5_000,
        () => false,
        () => 0,
      ),
    );
    expect(result).not.toContain('waiting for response');
  });
});

// ─── StreamRenderer integration — ttfbSpinnerFrame write-back ────────────────

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

describe('StreamRenderer — ttfbSpinnerFrame lifecycle', () => {
  it('initialises ttfbSpinnerFrame to 0', () => {
    const renderer = new StreamRenderer({
      out: writer,
      forceNonTty: true,
      turnStartedAt: Date.now(),
    });
    const priv = renderer as unknown as { ttfbSpinnerFrame: number };
    expect(priv.ttfbSpinnerFrame).toBe(0);
  });
});
