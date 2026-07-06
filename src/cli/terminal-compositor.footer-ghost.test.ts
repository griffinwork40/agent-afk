/**
 * Regression: the "double status line" + vanished loop-stage rail bug that
 * appears ONLY under the production footer geometry introduced by #634
 * (LoopStageBar reserves 1 extra row above the status line for the whole
 * session).
 *
 * Root cause: commitAbove() Phase 1 and evictRowsToScrollback() both perform a
 * FULL-SCREEN scroll inside StatusLine.withFullScrollRegion (so displaced lines
 * reach the terminal's native scrollback). That scroll drags the entire
 * reserved footer UP with it — the status row AND the loop-stage rail / bg bar
 * that sit in the `extraRows` band above it. The status row self-heals
 * (withFullScrollRegion re-flushes it), but the bars only otherwise repaint on
 * ResizeBus, so their scrolled-up copies orphan. The most visible symptom is a
 * DUPLICATE status row one line above the rail: once extraRows>0 the live frame
 * bottoms at `rows-1-extraRows`, so it no longer covers the `rows-1` row the
 * scrolled status copy lands on (pre-#634 the frame bottomed at `rows-1` and
 * covered it).
 *
 * Fix: StatusLine.setAfterScrollRestore() lets the caller (repl-loop) register
 * a footer-redraw callback that withFullScrollRegion fires after flush(), so
 * the rail / bg bar self-heal exactly like the status line.
 *
 * This test wires the REAL StatusLine + REAL LoopStageBar + REAL compositor
 * exactly as repl-loop does and drives the bytes through @xterm/headless. It
 * fails on the pre-fix code (status marker on 2 rows, rail gone) and passes
 * after (status marker on 1 row, rail intact). A sibling mock-based test was
 * used to first localize the bug; this one guards the production objects.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { LoopStageBar } from './commands/interactive/loop-stage.js';

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

function makeMockStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  return s;
}
function makeMockStdin(): MockStdin {
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
function termWriteSync(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}
function allLines(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const result: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line != null) result.push(line.translateToString(true));
  }
  return result;
}

const COLS = 80;
const ROWS = 24;
const COMMITTED = 'COMMITTED_TOOL_OUTPUT_LINE';
// model field is never dropped/truncated by StatusLine.formatLine, so it is a
// reliable single-occurrence marker for the status row.
const STATUS_MODEL = 'STATUSMODELXYZ';

/**
 * Wire the real footer exactly like repl-loop: StatusLine as the compositor's
 * scrollRegion guard, a LoopStageBar reserving 1 row, and the after-scroll
 * restore hook redrawing the rail (the fix).
 */
function wireFooter(stdout: MockStdout): { statusLine: StatusLine; loopStageBar: LoopStageBar } {
  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model: STATUS_MODEL, cost: 0, tokens: 0, contextPct: 0 });

  let bgBarRows = 0;
  const loopStageRows = 1;
  const loopStageBar = new LoopStageBar({
    getExtraRows: () => statusLine.getExtraRows(),
    stream: stdout,
  });
  loopStageBar.setRowCountChangeHandler(() => {
    statusLine.setExtraRows(loopStageRows + bgBarRows);
  });
  // THE FIX under test — without this the rail never self-heals after a scroll.
  statusLine.setAfterScrollRestore(() => loopStageBar.redraw());
  loopStageBar.start();
  return { statusLine, loopStageBar };
}

describe('footer-ghost regression (real StatusLine + LoopStageBar, extraRows=1)', () => {
  it('keeps the status row single and the rail intact after a multi-line commit + collapse', async () => {
    const stdout = makeMockStdout(COLS, ROWS);
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    const { statusLine, loopStageBar } = wireFooter(stdout);
    expect(statusLine.getExtraRows()).toBe(1); // sanity: rail reserved its row

    // Drive the bar to a mid-turn stage so the FULL 5-cell rail is the
    // expected row content — the idle 'observing' stage now collapses to a
    // single `· idle` cell (formatStageRail), which would defeat the
    // 'observe' + 'update' rail-finder probes below. redraw() (the self-heal
    // under test) re-asserts the stored currentStage, so the probes see the
    // same full rail after the scroll.
    loopStageBar.repaint('acting');

    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      scrollRegion: statusLine,
      anchorRow: 1,
    });
    await c.arm();

    const term = new HeadlessTerminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 400,
      allowProposedApi: true,
      convertEol: true,
    });

    // 1) Tall streaming overlay → frame grows, its top climbs high.
    const tall = Array.from({ length: 12 }, (_, i) => `stream line ${i}`).join('\n');
    c.setOverlay(tall);

    // 2) Commit a multi-line tool-output block above the tall frame (mirrors a
    //    subagent rollup) — each commit full-screen-scrolls via withFullScrollRegion.
    c.commitAbove(`${COMMITTED}\nrollup line A\nrollup line B\n`);

    // 3) Streaming ends → spinner appears (1-row growth → evict-scroll) + collapse.
    c.setSpinner({ enabled: true });
    c.setOverlay('');

    const internals = c as unknown as { repaint(): void };
    internals.repaint();
    internals.repaint();

    await termWriteSync(term, writes.all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    // BUG 2 — double status line: the status model marker must appear on AT MOST one row.
    const statusRows = lines.filter((l) => l.includes(STATUS_MODEL)).length;
    expect(
      statusRows,
      `status row rendered on ${statusRows} rows (expected 1 — the "double status line" bug):\n${dump}`,
    ).toBe(1);

    // The loop-stage rail must survive the scroll (it vanishes in the bug).
    const railRows = lines.filter((l) => l.includes('observe') && l.includes('update')).length;
    expect(railRows, `loop-stage rail not present after scroll:\n${dump}`).toBe(1);

    // BUG 1 — gap: at most one blank row between committed content and the frame.
    const committedIdx = lines.findIndex((l) => l.includes(COMMITTED));
    expect(committedIdx, `committed block not rendered:\n${dump}`).toBeGreaterThanOrEqual(0);
    let blankRun = 0;
    let maxBlankRun = 0;
    for (let i = committedIdx + 1; i < lines.length; i++) {
      // Stop scanning once we reach the footer band (rail/status) — gaps there
      // are a different concern; this asserts the committed→frame adjacency.
      if ((lines[i] ?? '').includes('observe') || (lines[i] ?? '').includes(STATUS_MODEL)) break;
      if ((lines[i] ?? '').trim() === '') {
        blankRun += 1;
        maxBlankRun = Math.max(maxBlankRun, blankRun);
      } else {
        blankRun = 0;
      }
    }
    expect(
      maxBlankRun,
      `large blank gap (${maxBlankRun} rows) between committed content and the frame:\n${dump}`,
    ).toBeLessThanOrEqual(1);

    term.dispose();
    loopStageBar.stop();
    statusLine.stop();
    c.disarm();
  }, 15_000);
});
