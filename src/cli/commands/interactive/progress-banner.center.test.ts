/**
 * AFK_CENTER_CONTENT: the live progress banner must not lose content to the
 * centering margin (audit item A6). The banner is an overlay row (never
 * committed via commitAbove), so it carries its own margin; the clamp budget
 * applies to the content, with the margin added on top.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsi } from '../../display.js';
import { formatProgressBanner } from './progress-banner.js';

const event = {
  taskId: 't',
  description: 'BANNERHEAD Running a long task description that should be visible BANNERTAIL',
  summary: 'reading files and doing important work here SUMMARYTAIL',
  totalTokens: 1234,
  toolUses: 5,
  durationMs: 12000,
};
let origCols: PropertyDescriptor | undefined;
beforeEach(() => {
  origCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
  vi.stubEnv('AFK_TEXT_MEASURE', '100');
});
afterEach(() => {
  if (origCols) Object.defineProperty(process.stdout, 'columns', origCols);
  else delete (process.stdout as { columns?: number }).columns;
  vi.unstubAllEnvs();
});

describe('formatProgressBanner under AFK_CENTER_CONTENT', () => {
  it('keeps the same content as the non-centered banner, shifted by exactly the margin', () => {
    vi.stubEnv('AFK_CENTER_CONTENT', '');
    const plain = formatProgressBanner(event).map(stripAnsi);
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    const centered = formatProgressBanner(event).map(stripAnsi);
    expect(centered).toHaveLength(plain.length);
    centered.forEach((line, i) => {
      expect(line).toBe(' '.repeat(50) + plain[i]);
      expect(line.length).toBeLessThanOrEqual(200);
    });
    expect(centered[0]).toContain('BANNERTAIL');
  });
});
