/**
 * History: a rendered markdown table committed under a tall overlay must
 * preserve its top border line (┌──┬──┐) through the commit → collapse cycle.
 *
 * The symptom: the table renders without its top border — the header row,
 * separator, data rows, and bottom border are all visible, but the ┌──┬──┐
 * line is missing. Root cause: commitPhase3Hold's tail-slice
 * (`model[model.length - paintedCount + i]`) leaves row 0 in a pending
 * prefix, and if the pending-overflow eviction in preserveRowsBeforeFrameRender
 * does not fire (or fires with insufficient overflow count), the row is
 * silently dropped when repositionCommittedBand slices `committedBand.slice(
 * committedBand.length - fit)`.
 *
 * This test is a sibling of overflow-gap.test.ts and collapse-void.test.ts.
 * Unlike those tests (which assert row-content text like 'Change'), this one
 * explicitly asserts the ┌ box-drawing border character — the blind spot in
 * the prior test coverage.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { renderMarkdownToTerminal } from './formatter.js';

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
function collect(stream: MockStdout): () => string {
  const c: string[] = [];
  stream.on('data', (x) => c.push(String(x)));
  return () => c.join('');
}
function termWrite(t: HeadlessTerminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r));
}
function allLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}

const COLS = 120, ROWS = 24;

// A realistic GFM table that produces a rendered table with ┌ top border.
const TABLE_MD = [
  '| PR | Description | CI | Findings |',
  '|---|---|---|---|',
  '| 40 | defense-in-depth comments | GREEN | 2 low |',
  '| 41 | move json import | BLOCKED | 1 medium |',
  '| 42 | strengthen assertions | GREEN | 2 nit |',
].join('\n');

describe('top-border drop: ┌ survives commitAbove under tall overlay', () => {
  it('the ┌ border line is present after overlay collapse (extraRows=2, spinner active)', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });

    const tableText = renderMarkdownToTerminal(TABLE_MD, { maxWidth: COLS - 2 });

    // Overlay height 10: tall enough that without the fix the table's ┌ border
    // (row 0 of the committed block) would land in the pending prefix while the
    // header, separator, data rows, and └ border are all painted — the exact
    // symptom observed in production. With the fix, paintedCount is snapped up
    // by 1 to pull the border into the painted region (maxRun=8 accommodates
    // the extra row). Note: overlay=11 would leave maxRun=7 < 8, so the snap
    // correctly does NOT fire there (best-effort cosmetic fix only).
    const tallOverlay = Array.from({ length: 10 }, (_, i) =>
      `thinking ${i} — dispatching review subagent`,
    ).join('\n');

    // Commit JUST the table under the tall overlay.
    c.setOverlay(tallOverlay);
    c.commitAbove(tableText.replace(/\n$/, '') + '\n\n');

    // ── Snapshot BEFORE collapse (overlay still active) ──
    const termMid = new HeadlessTerminal({
      cols: COLS, rows: ROWS, scrollback: 400,
      allowProposedApi: true, convertEol: true,
    });
    await termWrite(termMid, all());
    const midLines = allLines(termMid);
    const midHasTopBorder = midLines.some((l) => l.includes('┌'));
    const midHasHeader = midLines.some((l) => l.includes('Description'));
    termMid.dispose();

    // Overlay collapses (turn ends → spinner stops, overlay clears).
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    const internals = c as unknown as { repaint(): void };
    internals.repaint();
    internals.repaint();

    // Feed all compositor output through a headless terminal to get the
    // final rendered state (viewport + scrollback).
    const term = new HeadlessTerminal({
      cols: COLS, rows: ROWS, scrollback: 400,
      allowProposedApi: true, convertEol: true,
    });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) =>
      `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`,
    ).join('\n');

    // (0) Mid-turn state: ┌ must be visible BEFORE collapse too (the fix).
    expect(midHasTopBorder, `[mid-overlay] ┌ must be present while overlay is active (header present: ${midHasHeader})`).toBe(true);

    // (1) The table header text must be present (baseline — same as prior tests).
    const headerHits = lines.filter((l) => l.includes('Description')).length;
    expect(headerHits, `header row 'Description' must appear at least once:\n${dump}`).toBeGreaterThanOrEqual(1);

    // (2) The ┌ top border must be present (the NEW assertion — the blind spot).
    const topBorderHits = lines.filter((l) => l.includes('┌')).length;
    expect(topBorderHits, `top border ┌ must appear at least once (viewport or scrollback):\n${dump}`).toBeGreaterThanOrEqual(1);

    // (3) The └ bottom border must be present (sanity check).
    const bottomBorderHits = lines.filter((l) => l.includes('└')).length;
    expect(bottomBorderHits, `bottom border └ must appear at least once:\n${dump}`).toBeGreaterThanOrEqual(1);

    // (4) Top border must appear BEFORE the header (structural ordering).
    const topBorderIdx = lines.findIndex((l) => l.includes('┌'));
    const headerIdx = lines.findIndex((l) => l.includes('Description'));
    if (topBorderIdx >= 0 && headerIdx >= 0) {
      expect(topBorderIdx, `┌ (line ${topBorderIdx}) must appear before header (line ${headerIdx}):\n${dump}`)
        .toBeLessThan(headerIdx);
    }

    term.dispose(); statusLine.stop(); c.disarm();
  }, 20_000);
});
