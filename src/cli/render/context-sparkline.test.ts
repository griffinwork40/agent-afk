import { describe, it, expect } from 'vitest';
import { formatTurnSparkline } from './context-sparkline.js';

describe('formatTurnSparkline', () => {
  it('empty array returns empty string', () => {
    expect(formatTurnSparkline([])).toBe('');
  });

  it('single ratio 0 returns first block character', () => {
    expect(formatTurnSparkline([0])).toBe('▁');
  });

  it('single ratio 1 returns full block character', () => {
    expect(formatTurnSparkline([1])).toBe('█');
  });

  it('single ratio 0.5 returns middle block character', () => {
    expect(formatTurnSparkline([0.5])).toBe('▅');
  });

  it('multiple ratios return joined characters', () => {
    expect(formatTurnSparkline([0, 0.5, 1])).toBe('▁▅█');
  });

  it('slices to last n ratios (default n=5)', () => {
    expect(formatTurnSparkline([0, 0, 0, 0, 0, 0, 1, 1])).toBe('▁▁▁██');
  });

  it('custom n slices to last n ratios', () => {
    expect(formatTurnSparkline([0, 1, 0, 1, 0, 1], 3)).toBe('█▁█');
  });

  it('out-of-range negative values clamp to 0', () => {
    expect(formatTurnSparkline([-0.5])).toBe('▁');
  });

  it('out-of-range positive values clamp to 1', () => {
    expect(formatTurnSparkline([1.5])).toBe('█');
  });

  it('mixed out-of-range and in-range values', () => {
    expect(formatTurnSparkline([-0.5, 1.5])).toBe('▁█');
  });
});
