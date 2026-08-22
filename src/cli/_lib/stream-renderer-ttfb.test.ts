import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import { applyFirstContent } from './stream-renderer-ttfb.js';
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
