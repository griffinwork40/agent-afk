/**
 * Regression tests for A8: welcome-banner headerMaxW and legacy meta/hint wrap
 * must subtract the centering margin so that pad + content never overflows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
}

function maxLineWidth(output: string): number {
  return Math.max(...output.split('\n').map(l => stripAnsi(l).length));
}

describe('A8: welcome-banner does not overflow when centering is active', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    vi.stubEnv('AFK_TEXT_MEASURE', '100');
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hybrid banner: no line exceeds terminal width (200 cols, margin 50)', async () => {
    const { welcomeBanner } = await import('./welcome-banner.js');
    const cols = 200;
    const output = welcomeBanner({
      mode: 'Interactive Mode',
      model: 'claude-opus-4-5',
      version: '5.25.8',
      cwd: '/Users/verylongusername/projects/very-deep/nested/path/to/some/project',
      worktree: 'afk/center-l3-chrome-writers',
    });
    const maxW = maxLineWidth(output);
    expect(maxW).toBeLessThanOrEqual(cols);
  });

  it('legacy banner: metaLine and hintLine do not overflow when margin is prepended', async () => {
    const { welcomeBanner } = await import('./welcome-banner.js');
    const cols = 200;
    // Long metaLine that cannot be broken by wrapToWidth (no whitespace).
    // Before the fix: wrapTarget = tw = 200, lines up to 182 wide, then
    // pad(50) prepended → 232 > 200. After: wrapTarget = 150, lines are
    // truncated to 150, total = 200.
    const metaLine = 'x'.repeat(180);
    const hintLine = 'y'.repeat(180);
    const output = welcomeBanner({
      mode: 'Interactive Mode',
      metaLine,
      hintLine,
    });
    const maxW = maxLineWidth(output);
    expect(maxW).toBeLessThanOrEqual(cols);
  });

  it('default path (no centering): output is unchanged', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('AFK_TEXT_MEASURE', '100');
    const { welcomeBanner } = await import('./welcome-banner.js');
    const cols = 200;
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    const output = welcomeBanner({
      mode: 'Interactive Mode',
      model: 'claude-opus-4-5',
      version: '5.0.0',
    });
    // With centering off, no margin prepended; just verify it renders
    expect(output.length).toBeGreaterThan(0);
  });
});
