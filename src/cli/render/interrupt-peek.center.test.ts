/**
 * AFK_CENTER_CONTENT: interruptPeek's default width must be the content band
 * measure, not a fixed 80 (audit C3), so long context lines are not clipped
 * 20 cols early inside a 100-col band. Centering off keeps the 80 default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsi } from '../display.js';
import { interruptPeek } from './interrupt-peek.js';

const spec = {
  status: 'interrupting' as const,
  activeSubagent: { name: 'PEEKHEAD-' + 'n'.repeat(70) + '-PEEKTAIL', currentTool: 'bash' },
};
let orig: PropertyDescriptor | undefined;
beforeEach(() => {
  orig = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
  vi.stubEnv('AFK_TEXT_MEASURE', '100');
});
afterEach(() => {
  if (orig) Object.defineProperty(process.stdout, 'columns', orig);
  else delete (process.stdout as { columns?: number }).columns;
  vi.unstubAllEnvs();
});

describe('interruptPeek width under AFK_CENTER_CONTENT', () => {
  it('centered: context line uses the band measure and stays inside it', () => {
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    const lines = interruptPeek(spec).split('\n').map(stripAnsi);
    const ctx = lines.find((l) => l.includes('PEEKHEAD'))!;
    expect(ctx).toContain('PEEKTAIL');
    expect(ctx.length).toBeLessThanOrEqual(50 + 100);
  });
  it('centering off: default width stays 80', () => {
    vi.stubEnv('AFK_CENTER_CONTENT', '');
    const ctx = interruptPeek(spec).split('\n').map(stripAnsi).find((l) => l.includes('PEEKHEAD'))!;
    expect(ctx.length).toBeLessThanOrEqual(80);
    expect(ctx).not.toContain('PEEKTAIL');
  });
});
