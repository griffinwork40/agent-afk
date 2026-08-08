import { describe, it, expect } from 'vitest';
import { isPinnedToBottom, PIN_TOLERANCE_PX } from './scroll-pin.js';

describe('isPinnedToBottom', () => {
  it('is pinned when scrolled exactly to the bottom', () => {
    expect(isPinnedToBottom({ scrollTop: 900, scrollHeight: 1400, clientHeight: 500 })).toBe(true);
  });

  it('is pinned for a short, unscrollable transcript', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 })).toBe(true);
  });

  it('tolerates sub-pixel residue that exact equality would miss', () => {
    // The real-world case this constant exists for: a fractional device-pixel
    // ratio leaves a pixel or two of slack at a visually-bottomed view.
    expect(isPinnedToBottom({ scrollTop: 898.5, scrollHeight: 1400, clientHeight: 500 })).toBe(true);
  });

  it('is NOT pinned when the reader has scrolled up to read history', () => {
    expect(isPinnedToBottom({ scrollTop: 200, scrollHeight: 1400, clientHeight: 500 })).toBe(false);
  });

  it('treats the tolerance as inclusive at its exact boundary', () => {
    const scrollHeight = 1400;
    const clientHeight = 500;
    const atBoundary = scrollHeight - clientHeight - PIN_TOLERANCE_PX;
    expect(isPinnedToBottom({ scrollTop: atBoundary, scrollHeight, clientHeight })).toBe(true);
    expect(isPinnedToBottom({ scrollTop: atBoundary - 1, scrollHeight, clientHeight })).toBe(false);
  });

  it('honors an explicit tolerance override', () => {
    const m = { scrollTop: 880, scrollHeight: 1400, clientHeight: 500 };
    expect(isPinnedToBottom(m, 0)).toBe(false);
    expect(isPinnedToBottom(m, 100)).toBe(true);
  });
});
