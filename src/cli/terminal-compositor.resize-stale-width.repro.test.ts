/**
 * Regression suite for two confirmed TUI defects under mid-stream terminal
 * resize (tmux, multiple resizes). Originally an empirical repro file (RED
 * on both defects); converted to GREEN regression tests once fixed.
 *
 * DEFECT 1 (ghost frames / mid-word truncation at stale widths): committedBand
 * entries used to be hard-wrapped to terminal width ONCE at commit time
 * (terminal-compositor.committed-band-commit.ts, `hardWrapToWidth` at commit)
 * and later repainted VERBATIM by every paint site — repositionCommittedBand
 * (terminal-compositor.committed-band-repin.ts), and the frame-preserve
 * eviction paints (terminal-compositor.frame-preserve.ts). If a resize
 * narrowed the terminal after commit but before the band materialized
 * (band-hold defers materialization until overlay collapse), the repaint
 * painted rows wider than the new column count — DECAWM autowrap then
 * silently hard-wrapped them again at the hardware level, corrupting all
 * subsequent row math.
 *
 * FIX: terminal-compositor.band-reflow.ts's `reflowCommittedBandToWidth` is
 * called at every band-reading site (commitAbove, before it merges the prior
 * band; repaint(), before preserveRowsBeforeFrameRender/repositionCommittedBand
 * read it) — the retained LOGICAL content is re-wrapped at the CURRENT
 * terminal width every time, never trusted verbatim across a resize. Band
 * paint sites are additionally bracketed with DECAWM off/on
 * (`withAutowrapDisabled`) as a belt-and-braces defense against residual
 * ambiguous-width-glyph measurement gaps.
 *
 * DEFECT 2 (silent content loss): the SIGWINCH-immediate handler
 * (terminal-compositor.lifecycle.ts) calls `logUpdate.resetGeometry()`
 * (zeroing `CupFrameRenderer.previousTopRow`) but deliberately leaves
 * `committedBandTopRow`/`committedBandBottomRow` stale ("intentionally NOT
 * cleared" — preserved for repositionCommittedBand's later re-pin). A commit
 * landing before the debounced repaint used to compute
 * `prevTopRow = max(0, committedBandBottomRow + 1)`
 * (terminal-compositor.committed-band-commit.ts) — the stale floor reproduced
 * the PRE-resize row, kept `prevTopRow > 1`, and defeated the
 * `prevTopRow <= 1` band-hold safety fallback (BLOCKER-1 in commit-mode.ts).
 * `fitsAboveFrame` was then spuriously true and Phase-3 merge-then-cap
 * silently truncated the prior band as "already scrolled" rows that never
 * scrolled — the prior block vanished from screen AND scrollback.
 *
 * FIX: a new `bandGeometryStale` flag (TerminalCompositor) is set by the
 * SIGWINCH-immediate handler alongside `resetGeometry()`, and cleared only
 * once `repositionCommittedBand` re-pins the band against real post-resize
 * geometry. While stale, `commitAbove`'s `prevTopRow` computation skips the
 * `committedBandBottomRow + 1` floor entirely (falling through to the
 * genuinely-unknown-frame-top case BLOCKER-1 already handles safely), and
 * `decideCommitMode` forces `fitsAboveFrame` false and treats the prior band
 * as mergeable-by-invariant rather than requiring an exact (and, while stale,
 * unrecoverable) row-number match — so content rides into the band-hold model
 * as PENDING instead of being silently dropped.
 *
 * Commit 002bcd1 (PR #351) fixed a DIFFERENT trigger of this same failure
 * class (frame-height shrink at a STABLE column width) and must stay fixed —
 * see the baseline-sanity test below.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { stripAnsi, displayWidth } from './display.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';

type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
};
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

function makeStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}
function collectWrites(stream: MockStdout): { all: () => string } {
  const chunks: string[] = [];
  stream.on('data', (c: unknown) => chunks.push(String(c)));
  return { all: () => chunks.join('') };
}

/** Internal view used to read the compositor's private geometry tracking. */
interface Internals {
  repaint(): void;
  committedBand: string[];
  committedBandTopRow: number;
  committedBandBottomRow: number;
  committedBandPaintedRows: number;
  logUpdate: { topRow?: number } | null;
}

/** Parse every `CUP row;1H` + `EL` + content write (eraseAndPaintRow's shape). */
function parseErasePaintWrites(out: string): { row: number; content: string }[] {
  const re = /\x1b\[(\d+);1H\x1b\[2K([^\x1b]*)/g;
  const writes: { row: number; content: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    writes.push({ row: Number(m[1]), content: m[2] ?? '' });
  }
  return writes;
}

describe('TerminalCompositor — resize-window stale-geometry corruption (H1 + H2 fix regression)', () => {
  const armed: TerminalCompositor[] = [];

  afterEach(() => {
    // arm() registers a process-level SIGWINCH listener via ResizeBus; a failing
    // assertion would otherwise leak it and hang the run. Disarm defensively —
    // mirrors terminal-compositor.resize-ghost.test.ts's afterEach.
    while (armed.length > 0) {
      try {
        armed.pop()?.disarm();
      } catch {
        /* idempotent */
      }
    }
    vi.useRealTimers();
  });

  it('H1 FIXED: repositionCommittedBand re-wraps stale-width band rows at the CURRENT width after a column-shrink resize — no content loss, no overwide rows', async () => {
    vi.useFakeTimers();
    const stdout = makeStdout(160, 24);
    const stdin = makeStdin();
    const writes = collectWrites(stdout);
    const vscreen = new VirtualScreen(64, 24); // final post-resize geometry
    stdout.on('data', (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) vscreen.write(chunk as Buffer);
      else if (typeof chunk === 'string') vscreen.write(Buffer.from(chunk, 'utf-8'));
    });
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      scrollRegion: statusLine,
      anchorRow: 1,
    });
    armed.push(c);
    await c.arm();
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });
    const internals = c as unknown as Internals;

    // Force band-hold: a 22-line overlay fills the 24-row viewport, so the
    // commit below lands with prevTopRow<=1 and is HELD in the model rather
    // than immediately painted (band-hold, terminal-compositor.h1-prevtoprow
    // .test.ts documents this routing). The block is committed at cols=160.
    const tallOverlay = Array.from(
      { length: 22 },
      (_, i) => `thinking ${i} — held overlay row keeping the frame at full height`,
    ).join('\n');
    c.setOverlay(tallOverlay);

    // Each row is 100 display columns: < 160 (fits, no wrap at commit time)
    // but > 64 (the post-resize width), so it is a clean witness for
    // "was this re-wrapped at repaint time, or painted at its stale width?"
    const mkRow = (tag: string): string => `${tag}_` + 'Y'.repeat(100 - tag.length - 1);
    const blockLines = [mkRow('L01'), mkRow('L02'), mkRow('L03')];
    c.commitAbove(blockLines.join('\n') + '\n\n');

    // Precondition: the band-hold model holds the block, hard-wrapped at the
    // COMMIT-TIME width (100 chars, unwrapped because 100 < 160).
    expect(internals.committedBand.length).toBeGreaterThan(0);
    for (const line of internals.committedBand) {
      if (line.length > 0) expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(100);
    }

    // Resize: cols 160 -> 64 (a pure-width SIGWINCH, tmux pane-split style).
    // Fire both the immediate AND (after advancing timers) the debounced
    // channel, exactly as terminal-compositor.resize-ghost.test.ts does.
    stdout.columns = 64;
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);

    // Collapse the overlay so band-hold materializes the pending model —
    // this is where repositionCommittedBand paints the retained band rows.
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const out = writes.all();
    const paints = parseErasePaintWrites(out);
    const overWidth = paints.filter((p) => displayWidth(stripAnsi(p.content)) > 64);

    // (a) Every painted row's display width fits the CURRENT (post-resize)
    // terminal width — the compositor re-wraps retained content when it
    // finally paints it, because the geometry it was captured under no
    // longer exists.
    expect(
      overWidth,
      `expected no band row wider than the post-resize terminal width (64 cols); ` +
        `found: ${JSON.stringify(overWidth.slice(0, 3))}`,
    ).toEqual([]);

    // (b) Every committed logical line's content is fully present in the
    // final combined scrollback+viewport buffer — re-wrapping may change
    // WHERE a line breaks, but must never drop characters. Reconstruct each
    // logical line's content (rejoin the ANSI-stripped screen, drop the
    // static overlay/status-line chrome rows) and check the full marker text
    // survives somewhere contiguous.
    const combined = [...vscreen.scrollbackLines(), ...vscreen.visibleLines()].join('\n');
    for (const line of blockLines) {
      const [tag, ...rest] = line.split('_');
      const body = rest.join('_');
      // The tag prefix (e.g. "L01_") must survive intact — re-wrapping never
      // splits it because it is only 4 chars, far under any tested width.
      expect(combined, `marker "${tag}_" missing from final screen`).toContain(`${tag}_`);
      // Full content check: strip all whitespace/newlines from the region
      // around the tag and confirm the complete 96-char run of 'Y' is there,
      // proving no characters were dropped by the re-wrap (only reflowed).
      const flattenedRun = combined.replace(/\s+/g, '');
      expect(
        flattenedRun,
        `full un-wrapped content for ${tag} not found contiguously (content loss)`,
      ).toContain(`${tag}_${body}`.replace(/\s+/g, ''));
    }
  }, 15_000);

  it('H2 FIXED: a commit landing between the SIGWINCH-immediate handler and the debounced repaint no longer drops the PRIOR committed block — both blocks survive, no row exceeds the new width', async () => {
    vi.useFakeTimers();
    const stdout = makeStdout(160, 24);
    const stdin = makeStdin();
    // VirtualScreen is the repo's own synchronous ANSI interpreter (used by
    // terminal-compositor.resize-ghost.test.ts) — chosen over @xterm/headless
    // here because @xterm/headless's internal async parsing does not resolve
    // under vi.useFakeTimers(), which this test needs for the SIGWINCH
    // immediate/debounced-channel split.
    const vscreen = new VirtualScreen(100, 24); // final post-resize geometry
    stdout.on('data', (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) vscreen.write(chunk as Buffer);
      else if (typeof chunk === 'string') vscreen.write(Buffer.from(chunk, 'utf-8'));
    });
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      scrollRegion: statusLine,
      anchorRow: 1,
    });
    armed.push(c);
    await c.arm();
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });
    const internals = c as unknown as Internals;

    // Overlay lines are 120 display columns: ONE physical row at cols=160,
    // but wrap to TWO physical rows at cols=100. This makes the resize a
    // genuine PHYSICAL-geometry change (frame row count changes) without
    // touching stdout.rows at all — the pure-width analog of a shrink.
    const mkOverlayLine = (i: number): string => `OV${i}_` + 'Z'.repeat(120 - `OV${i}_`.length);
    const overlay8 = Array.from({ length: 8 }, (_, i) => mkOverlayLine(i)).join('\n');
    c.setOverlay(overlay8);

    // Commit A at cols=160 — fits above the frame; single-copy paint, band
    // tracks it adjacent to the (wide) frame top.
    c.commitAbove('BLOCK_A_marker committed at cols=160\n\n');
    expect(internals.committedBand.some((l) => l.includes('BLOCK_A_marker'))).toBe(true);

    // Resize cols 160 -> 100. Fire ONLY the immediate (synchronous) SIGWINCH
    // channel — the 150ms debounce that would repaint at the new geometry
    // has deliberately NOT fired yet. This is the exact window H2 targets:
    // "commits landing between SIGWINCH and next debounced repaint."
    stdout.columns = 100;
    process.stdout.emit('resize');

    // Commit B lands inside that window.
    c.commitAbove('BLOCK_B_marker committed right after resize\n\n');

    // Now let the debounce fire and the overlay collapse, exactly like a
    // real session settling after the resize.
    vi.advanceTimersByTime(150);
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const combined = [...vscreen.scrollbackLines(), ...vscreen.visibleLines()];
    const combinedText = combined.join('\n');

    // Both committed blocks are internally-consistent and BOTH survive
    // somewhere in the combined scrollback+viewport buffer — a commit is
    // never silently unwritten, regardless of a resize landing mid-commit.
    expect(combinedText).toContain('BLOCK_A_marker');
    expect(combinedText).toContain('BLOCK_B_marker');
    // Each appears exactly once — no duplicate ghost copy from the fix's
    // band-hold-as-pending routing.
    expect(combinedText.split('BLOCK_A_marker').length - 1).toBe(1);
    expect(combinedText.split('BLOCK_B_marker').length - 1).toBe(1);
    // No painted row exceeds the new (post-resize) terminal width.
    for (const line of combined) {
      expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(100);
    }
  }, 15_000);

  it('baseline sanity: the 002bcd1 shrink-padding case (H2 original target) remains fixed — prior committed prose still survives a frame-height shrink at a STABLE column width', async () => {
    // Re-derives (does not import) the scenario terminal-compositor.commit-geometry
    // .test.ts pins, as a narrow confirmation that this file's H2 fix is a
    // DIFFERENT residual trigger's fix, not a regression of 002bcd1's original one.
    const stdout = makeStdout(120, 24);
    const stdin = makeStdin();
    const writes = collectWrites(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      scrollRegion: statusLine,
      anchorRow: 1,
    });
    armed.push(c);
    await c.arm();
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });
    const internals = c as unknown as Internals;

    const tallOverlay = Array.from(
      { length: 14 },
      (_, i) => `thinking ${i} — subagent dispatched, analysing claim ${i}`,
    ).join('\n');
    c.setOverlay(tallOverlay);
    c.commitAbove('GEO_PROSE committed block — should survive the shrink\n\n');
    expect(internals.committedBandBottomRow).toBe(4);

    // Shrink the OVERLAY height only — no SIGWINCH, no column change. This is
    // 002bcd1's original trigger: CupFrameRenderer shrink-padding within a
    // stable-width session.
    const smallOverlay = Array.from({ length: 4 }, (_, i) => `overlay shrunk ${i}`).join('\n');
    c.setOverlay(smallOverlay);
    expect(internals.committedBandBottomRow).toBe(14); // repositionCommittedBand re-pinned it

    c.commitAbove(
      'GEO_TABLE_ROW_1 | data | col\n' +
        'GEO_TABLE_ROW_2 | data | col\n' +
        'GEO_TABLE_ROW_3 | data | col\n\n',
    );
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const out = writes.all();
    expect(out).toContain('GEO_PROSE');
    expect(out).toContain('GEO_TABLE_ROW_1');
  }, 15_000);

  it('multi-resize storm: commit, resize 160→100, commit, resize 100→64, collapse — all content present exactly once, no row exceeds 64 cols', async () => {
    vi.useFakeTimers();
    const stdout = makeStdout(160, 24);
    const stdin = makeStdin();
    const vscreen = new VirtualScreen(64, 24); // final post-resize geometry
    stdout.on('data', (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) vscreen.write(chunk as Buffer);
      else if (typeof chunk === 'string') vscreen.write(Buffer.from(chunk, 'utf-8'));
    });
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      scrollRegion: statusLine,
      anchorRow: 1,
    });
    armed.push(c);
    await c.arm();
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });
    const internals = c as unknown as Internals;

    // A tall-but-not-full overlay: big enough to hold both commits above the
    // frame in the band model (exercising BOTH the H1 stale-width repaint
    // path and the H2 stale-geometry commit path across TWO width changes),
    // without pinning prevTopRow<=1 for the whole scenario.
    const tallOverlay = Array.from({ length: 20 }, (_, i) => `thinking ${i} — held overlay row`).join(
      '\n',
    );
    c.setOverlay(tallOverlay);

    // Commit STORM_ONE at cols=160.
    c.commitAbove('STORM_ONE_marker committed at 160 cols with extra padding text here\n\n');

    // Resize 160 -> 100, mirroring H2's window: the debounce has NOT fired
    // yet when the next commit lands.
    stdout.columns = 100;
    process.stdout.emit('resize');

    // Commit STORM_TWO inside that stale-geometry window.
    c.commitAbove('STORM_TWO_marker committed right after first resize event landing\n\n');

    // Let the first resize's debounced repaint settle geometry at 100 cols.
    vi.advanceTimersByTime(150);
    internals.repaint();

    // Second resize: 100 -> 64 (narrower again — re-wraps whatever was
    // wrapped at 100 back down to 64, exercising reflow-of-a-reflow).
    stdout.columns = 64;
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);

    // Collapse the overlay so the band model fully materializes.
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const combined = [...vscreen.scrollbackLines(), ...vscreen.visibleLines()];
    const combinedText = combined.join('\n');

    // Each unique marker string appears EXACTLY ONCE — no duplicate ghost
    // copies from any of the two resizes or two commits.
    expect(combinedText.split('STORM_ONE_marker').length - 1).toBe(1);
    expect(combinedText.split('STORM_TWO_marker').length - 1).toBe(1);

    // No row in the final combined buffer exceeds the FINAL terminal width
    // (64 cols) — content committed at 160 and re-wrapped once already (to
    // 100) is re-wrapped AGAIN to the final width, not left stale at an
    // intermediate width.
    for (const line of combined) {
      expect(
        displayWidth(stripAnsi(line)),
        `row exceeds 64 cols after the multi-resize storm: ${JSON.stringify(line)}`,
      ).toBeLessThanOrEqual(64);
    }
  }, 15_000);
});
