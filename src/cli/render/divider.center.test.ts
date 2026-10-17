/**
 * Regression tests for C2: divider() default width min(tw,120) must be capped
 * to contentBand(tw).width in centered mode so the rule does not extend past
 * the content band.
 *
 * Default (non-centered) output must be byte-identical.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
}

describe('C2: divider() respects band width in centered mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('centered tw=200, measure=100: divider width <= band width (150)', async () => {
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    vi.stubEnv('AFK_TEXT_MEASURE', '100');
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    const { divider } = await import('./divider.js');
    const result = stripAnsi(divider());
    // band width = 200 - 50 = 150; divider must not exceed that
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it('centered with title: divider does not overflow band', async () => {
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    vi.stubEnv('AFK_TEXT_MEASURE', '100');
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    const { divider } = await import('./divider.js');
    const result = stripAnsi(divider('Section'));
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it('default path (no centering): divider width is min(tw, 120) unchanged', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    const { divider } = await import('./divider.js');
    const result = stripAnsi(divider());
    // Default: min(200, 120) = 120
    expect(result.length).toBe(120);
  });

  it('default path narrow terminal (tw=80): divider width is 80', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    const { divider } = await import('./divider.js');
    const result = stripAnsi(divider());
    expect(result.length).toBe(80);
  });

  it('explicit maxWidth overrides band in centered mode', async () => {
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    vi.stubEnv('AFK_TEXT_MEASURE', '100');
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    const { divider } = await import('./divider.js');
    const result = stripAnsi(divider(undefined, 60));
    // Caller explicitly passes maxWidth=60; should respect that cap
    expect(result.length).toBeLessThanOrEqual(60);
  });
});
