import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { PassThrough } from 'node:stream';

const counts = vi.hoisted(() => ({ format: 0, segment: 0 }));
vi.mock('./markdown-stream-format.js', async (orig) => {
  const mod = await orig<typeof import('./markdown-stream-format.js')>();
  return {
    ...mod,
    formatPendingBuffer: (...args: Parameters<typeof mod.formatPendingBuffer>) => {
      counts.format++;
      return mod.formatPendingBuffer(...args);
    },
  };
});
vi.mock('./smoke-reveal.ansi.js', async (orig) => {
  const mod = await orig<typeof import('./smoke-reveal.ansi.js')>();
  return {
    ...mod,
    segmentAnsi: (text: string) => {
      counts.segment++;
      return mod.segmentAnsi(text);
    },
  };
});

const { PendingFormatCache } = await import('./markdown-stream.pending-cache.js');
const { StreamingMarkdownRenderer } = await import('./markdown-stream.js');
const { applyTheme } = await import('./theme.js');

let savedLevel: typeof chalk.level;
beforeEach(() => {
  savedLevel = chalk.level;
  chalk.level = 3;
  counts.format = 0;
  counts.segment = 0;
});
afterEach(() => {
  chalk.level = savedLevel;
  applyTheme('dark');
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('PendingFormatCache', () => {
  it('does not reformat an unchanged buffer', () => {
    const format = vi.fn((b: string) => `<${b}>`);
    const cache = new PendingFormatCache(format);
    const a = cache.render('hello **world**', 80, true);
    const b = cache.render('hello **world**', 80, true);
    expect(b).toBe(a);
    expect(format).toHaveBeenCalledTimes(1);
  });

  it('reformats when any key input changes: buffer, width, render flag, theme, color level', () => {
    const format = vi.fn((b: string, w: number, r: boolean) => `${b}|${w}|${r}`);
    const cache = new PendingFormatCache(format);
    cache.render('abc', 80, true);
    cache.render('abcd', 80, true);
    cache.render('abcd', 60, true);
    cache.render('abcd', 60, false);
    applyTheme('light');
    cache.render('abcd', 60, false);
    chalk.level = 1;
    cache.render('abcd', 60, false);
    expect(format).toHaveBeenCalledTimes(6);
    cache.render('abcd', 60, false);
    expect(format).toHaveBeenCalledTimes(6);
  });

  it('reports open-fence / open-table state and the row count of the render', () => {
    const cache = new PendingFormatCache((b) => b);
    expect(cache.render('```ts\nconst x', 80, true)).toMatchObject({ inCode: true, inTable: false, rows: 2 });
    expect(cache.render('| a | b |\n|---|---|', 80, true)).toMatchObject({ inCode: false, inTable: true });
    cache.clear();
    expect(cache.render('plain', 80, true)).toMatchObject({ inCode: false, inTable: false, rows: 1 });
  });
});

describe('StreamingMarkdownRenderer frame cost', () => {
  it('reveal frames on an unchanged buffer neither reformat nor re-segment it', async () => {
    vi.useFakeTimers();
    vi.stubEnv('AFK_PLAIN_OUTPUT', '');
    vi.stubEnv('AFK_REDUCED_MOTION', '');
    vi.stubEnv('AFK_INK_TEXT', '');
    let paints = 0;
    const stub = {
      setOverlay: () => { paints++; },
      commitAbove: () => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };
    const out = new PassThrough();
    (out as unknown as { isTTY: boolean }).isTTY = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = new StreamingMarkdownRenderer({ out: out as any, compositor: stub as any });
    r.push('The quick **brown** fox jumps over the lazy dog and keeps on running');
    await vi.advanceTimersByTimeAsync(2_000);
    // Many animation frames were painted from ONE formatted buffer.
    expect(paints).toBeGreaterThan(5);
    expect(counts.format).toBe(1);
    expect(counts.segment).toBe(1);
    r.dispose();
  });
});
