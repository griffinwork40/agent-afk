/**
 * ThoughtSummaryHold: the `◆ thought for Xs` line fades in live, then commits.
 *
 * Pins:
 *  1. Held first (overlay, faded), committed later with the EXACT bytes the
 *     no-smoke path writes, exactly once.
 *  2. Scrollback order: any other commit that arrives first pulls the summary
 *     in ahead of it (compositor commit barrier), as do endTurn/disarm.
 *  3. Commit sequence: the overlay drops the line BEFORE it is committed.
 *  4. On a real armed compositor the summary lands once, above later output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { ThoughtSummaryHold, THOUGHT_SUMMARY_SLOT } from './thought-summary-hold.js';
import { OverlayComposer } from './overlay-composer.js';
import { ElementFade, FADE_MS, FADE_FRAME_MS } from '../smoke-fade.js';
import { resetSmokeToneCache } from '../smoke-reveal.tones.js';
import { TerminalCompositor } from '../terminal-compositor.js';
import { formatThoughtSummary } from '../commands/interactive/thinking-lane.js';
import { stripAnsi } from '../display.js';

let SUMMARY = '';

/** Fake compositor that honors the barrier contract like TerminalCompositor. */
function makeFakes(): {
  events: string[];
  compositor: { commitAbove(t: string): void; setCommitBarrier(fn: (() => void) | null): void; overlay: string };
  composer: OverlayComposer;
  fade: ElementFade;
  hold: ThoughtSummaryHold;
} {
  const events: string[] = [];
  let barrier: (() => void) | null = null;
  const compositor = {
    overlay: '',
    setOverlay(t: string) { this.overlay = t; events.push(`overlay:${stripAnsi(t)}`); },
    setCommitBarrier(fn: (() => void) | null) { barrier = fn; },
    commitAbove(t: string) {
      const b = barrier;
      if (b) { barrier = null; b(); }
      events.push(`commit:${t}`);
    },
  };
  const composer = new OverlayComposer(compositor, [THOUGHT_SUMMARY_SLOT, 'below']);
  const fade = new ElementFade(() => { composer.markDirty(THOUGHT_SUMMARY_SLOT); composer.flush(); });
  const hold = new ThoughtSummaryHold(compositor, composer, fade);
  composer.register({ key: THOUGHT_SUMMARY_SLOT, render: () => hold.render() });
  return { events, compositor, composer, fade, hold };
}

let savedLevel: typeof chalk.level;
beforeEach(() => {
  vi.useFakeTimers();
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
  // Built after chalk.level is raised so the summary carries its real styling.
  SUMMARY = formatThoughtSummary(2300, 400);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  chalk.level = savedLevel;
});

describe('ThoughtSummaryHold', () => {
  it('shows the summary faded in the overlay, then commits the exact line once', () => {
    const { events, compositor, hold } = makeFakes();
    hold.hold(SUMMARY);
    expect(events.filter((e) => e.startsWith('commit:'))).toEqual([]);
    expect(stripAnsi(compositor.overlay)).toBe(stripAnsi(SUMMARY));
    expect(compositor.overlay).not.toBe(SUMMARY); // faded, not the settled styling

    vi.advanceTimersByTime(FADE_MS + FADE_FRAME_MS);
    expect(events.filter((e) => e.startsWith('commit:'))).toEqual([`commit:${SUMMARY}`]);
    expect(compositor.overlay).toBe('');
    vi.advanceTimersByTime(1000);
    expect(events.filter((e) => e.startsWith('commit:'))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops the line from the overlay BEFORE committing it', () => {
    const { events, hold } = makeFakes();
    hold.hold(SUMMARY);
    events.length = 0;
    hold.commitHeld();
    expect(events).toEqual(['overlay:', `commit:${SUMMARY}`]);
  });

  it('commits ahead of any later commit that arrives mid-fade (barrier)', () => {
    const { events, compositor, hold } = makeFakes();
    hold.hold(SUMMARY);
    compositor.commitAbove('TOOL ROW');
    expect(events.filter((e) => e.startsWith('commit:'))).toEqual([`commit:${SUMMARY}`, 'commit:TOOL ROW']);
    vi.advanceTimersByTime(FADE_MS * 2);
    expect(events.filter((e) => e.startsWith('commit:'))).toHaveLength(2);
  });

  it('a newer hold commits the older summary first, preserving order', () => {
    const { events, hold } = makeFakes();
    const second = formatThoughtSummary(900, 80);
    hold.hold(SUMMARY);
    hold.hold(second);
    vi.advanceTimersByTime(FADE_MS * 2);
    expect(events.filter((e) => e.startsWith('commit:'))).toEqual([`commit:${SUMMARY}`, `commit:${second}`]);
  });

  it('dispose() commits a still-held summary and is idempotent', () => {
    const { events, hold, fade } = makeFakes();
    hold.hold(SUMMARY);
    hold.dispose();
    hold.dispose();
    expect(events.filter((e) => e.startsWith('commit:'))).toEqual([`commit:${SUMMARY}`]);
    fade.dispose(); // the shared frame driver is owned (and disposed) by armSmokeEffects
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders the settled line with no restyling once the fade has elapsed', () => {
    const { fade, compositor } = makeFakes();
    const composer = new OverlayComposer(compositor as never, [THOUGHT_SUMMARY_SLOT]);
    const hold = new ThoughtSummaryHold({ commitAbove: vi.fn(), setCommitBarrier: vi.fn() }, composer, fade);
    composer.register({ key: THOUGHT_SUMMARY_SLOT, render: () => hold.render() });
    hold.hold(SUMMARY);
    vi.advanceTimersByTime(FADE_MS);
    expect(hold.render()).toBe(SUMMARY);
  });
});

// ── Real compositor on a headless terminal ─────────────────────────────────

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };
function makeStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true; s.columns = cols; s.rows = rows; return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true; s.isRaw = false; s.setRawMode = vi.fn((r: boolean) => { s.isRaw = r; return s; }); return s;
}

describe('ThoughtSummaryHold on an armed TerminalCompositor', () => {
  it('lands once in scrollback, above output committed during its fade', async () => {
    vi.useRealTimers();
    const stdout = makeStdout(80, 24);
    const chunks: string[] = [];
    stdout.on('data', (x) => chunks.push(String(x)));
    const c = new TerminalCompositor({ stdout, stdin: makeStdin(), onCancel: vi.fn() });
    await c.arm();
    const composer = new OverlayComposer(c, [THOUGHT_SUMMARY_SLOT, 'tool-lane']);
    let toolOverlay = '';
    composer.register({ key: 'tool-lane', render: () => toolOverlay });
    const fade = new ElementFade(() => { composer.markDirty(THOUGHT_SUMMARY_SLOT); composer.flush(); });
    const hold = new ThoughtSummaryHold(c, composer, fade);
    composer.register({ key: THOUGHT_SUMMARY_SLOT, render: () => hold.render() });

    hold.hold(SUMMARY);
    toolOverlay = '   ● Read(src/a.ts) …';
    composer.markDirty('tool-lane');
    composer.flush();
    // The tool row lands in scrollback mid-fade: the summary must go first.
    toolOverlay = '';
    composer.markDirty('tool-lane');
    composer.flush();
    c.commitAbove('   ● Read(src/a.ts) — ✓');
    c.endTurn();
    c.disarm();
    fade.dispose();

    const term = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((r) => term.write(chunks.join(''), r));
    const buf = term.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < buf.length; i++) rows.push(buf.getLine(i)?.translateToString(true) ?? '');
    const summaryRows = rows.map((r, i) => [r, i] as const).filter(([r]) => r.includes('thought for 2.3s'));
    const toolRow = rows.findIndex((r) => r.includes('Read(src/a.ts) — ✓'));
    expect(summaryRows).toHaveLength(1);
    expect(toolRow).toBeGreaterThan(summaryRows[0]![1]);
    term.dispose();
  });
});
