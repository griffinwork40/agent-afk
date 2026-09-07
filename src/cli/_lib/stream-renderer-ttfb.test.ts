import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import { applyFirstContent, renderTtfbWaitingLine, TTFB_GRACE_MS } from './stream-renderer-ttfb.js';
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

// Braille spinner frames used by streamProgress
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

describe('renderTtfbWaitingLine', () => {
  it('returns empty string when isTtfbDone returns true', () => {
    const startedAt = Date.now() - TTFB_GRACE_MS - 1000;
    const result = renderTtfbWaitingLine(
      () => startedAt,
      () => true,
      () => 0,
    );
    expect(result).toBe('');
  });

  it('returns empty string when elapsed < TTFB_GRACE_MS', () => {
    vi.useFakeTimers();
    const startedAt = Date.now() - (TTFB_GRACE_MS - 500);
    const result = renderTtfbWaitingLine(
      () => startedAt,
      () => false,
      () => 0,
    );
    expect(result).toBe('');
    vi.useRealTimers();
  });

  it('returns empty string when any getter is undefined', () => {
    const startedAt = Date.now() - TTFB_GRACE_MS - 1000;
    expect(renderTtfbWaitingLine(undefined, () => false, () => 0)).toBe('');
    expect(renderTtfbWaitingLine(() => startedAt, undefined, () => 0)).toBe('');
    expect(renderTtfbWaitingLine(() => startedAt, () => false, undefined)).toBe('');
  });

  it('returns empty string when getTtfbStartedAt returns undefined', () => {
    const result = renderTtfbWaitingLine(
      () => undefined,
      () => false,
      () => 0,
    );
    expect(result).toBe('');
  });

  it('returns a string with a braille spinner glyph and "waiting for response…" when active', () => {
    vi.useFakeTimers();
    const startedAt = Date.now() - TTFB_GRACE_MS - 2000;
    const result = renderTtfbWaitingLine(
      () => startedAt,
      () => false,
      () => 0,
    );
    expect(result).not.toBe('');
    expect(result).toContain('waiting for response…');
    // Strip ANSI to verify braille glyph presence
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
    const hasBraille = BRAILLE_FRAMES.some((g) => stripped.includes(g));
    expect(hasBraille).toBe(true);
    vi.useRealTimers();
  });

  it('produces different spinner glyphs for different spinnerFrame values', () => {
    vi.useFakeTimers();
    const startedAt = Date.now() - TTFB_GRACE_MS - 2000;
    const makeResult = (frame: number) =>
      renderTtfbWaitingLine(() => startedAt, () => false, () => frame);

    // Collect stripped results for multiple consecutive frames
    const results = Array.from({ length: BRAILLE_FRAMES.length }, (_, i) =>
      makeResult(i).replace(/\x1b\[[0-9;]*m/g, ''),
    );

    // All frames should be non-empty
    for (const r of results) {
      expect(r).not.toBe('');
    }

    // At least two distinct results exist (the spinner actually advances)
    const unique = new Set(results);
    expect(unique.size).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});

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
