/**
 * Regression (the "tables render fucky" report): many SMALL blocks committed
 * under a TALL overlay each fit the current tall-frame room, so they take the
 * eager fits-path and scroll into native scrollback. On collapse the surviving
 * band re-pins DOWN to the bottom-pinned frame while the prematurely-archived
 * rows stay frozen in scrollback → a multi-row VOID between them, and the
 * earliest row can be lost entirely.
 *
 * This is the collapsed-frame-height boundary gap that overflow-gap.test.ts
 * (isolation note ~198-205) and docs/scrollback.md:400-405 deliberately left
 * out of scope. Geometry: 100x40, a 22-row overlay held across the commits, a
 * report ending in a rendered wide table, then a minimal-frame collapse whose
 * above-frame room (~37) is much larger than the surviving band (~12).
 *
 * FIX INVARIANT (A2 — unified retained model): while the geometry is still
 * mutable (tall overlay up) content that would fit above the COLLAPSED frame is
 * RETAINED in the band model, not eagerly archived. On collapse the whole run
 * paints contiguously hugging the frame. So: every committed row present
 * exactly once, no >=2-row void between content and frame, run hugs the frame.
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
function collect(stream: MockStdout): () => string { const c: string[] = []; stream.on('data', (x) => c.push(String(x))); return () => c.join(''); }
function termWrite(t: HeadlessTerminal, d: string): Promise<void> { return new Promise((r) => t.write(d, r)); }
function allLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}

const COLS = 100, ROWS = 40;
const FRAME_RE = /\u23af/; // input rule glyph on a minimal (spinner-stopped) frame

describe('collapse void: many small commits under a tall overlay', () => {
  it('keeps the whole report contiguous and hugging the frame after collapse (no void, no lost rows)', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    statusLine.setExtraRows(1);
    c.setSpinner({ enabled: true });

    const overlay = Array.from({ length: 22 }, (_, i) => `thinking ${i} keeping the frame tall`).join('\n');
    const commit = (s: string): void => { c.setOverlay(overlay); c.commitAbove(s); };

    const reportRows = ['HEADER-MARKER Diagnosis summary'];
    commit('HEADER-MARKER Diagnosis summary\n\n');
    for (let i = 1; i <= 6; i++) { const r = `PROSE-${String(i).padStart(2, '0')} report line`; reportRows.push(r); commit(`${r}\n\n`); }
    const TABLE_MD = [
      '| # | Change | File | Nature |',
      '|---|--------|------|--------|',
      '| 1 | pass cwd to scheduler | scheduler.ts | behavior |',
      '| 2 | load config from cwd | config-loader.ts | behavior |',
      '| 3 | thread cwd through daemon | daemon.ts | plumbing |',
    ].join('\n');
    const table = renderMarkdownToTerminal(TABLE_MD, { maxWidth: COLS - 2 }).replace(/\n+$/, '');
    reportRows.push('BODY-TAIL-ROW final line of report');
    commit(`${table}\nBODY-TAIL-ROW final line of report\n\n`);

    // Collapse to a minimal frame (spinner off) so the above-frame room is large.
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    const internals = c as unknown as { repaint(): void };
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 800, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    const frameAbs = lines.findIndex((l) => FRAME_RE.test(l));
    expect(frameAbs, `frame not found:\n${dump}`).toBeGreaterThanOrEqual(0);

    // (1) NO LOST / DUPLICATE ROWS: every committed report row present exactly once.
    for (const row of reportRows) {
      const label = (row.match(/HEADER-MARKER|PROSE-\d\d|BODY-TAIL-ROW/) ?? [row])[0];
      const hits = lines.filter((l) => l.includes(label)).length;
      expect(hits, `row "${label}" must appear exactly once (found ${hits}):\n${dump}`).toBe(1);
    }

    // (2) NO VOID: no run of >=2 blank rows between the first content row and the frame.
    const firstContentAbs = lines.findIndex((l) => l.trim() !== '');
    let maxBlankRun = 0, cur = 0;
    for (let i = Math.max(0, firstContentAbs); i < frameAbs; i++) {
      if ((lines[i] ?? '').trim() === '') { cur++; maxBlankRun = Math.max(maxBlankRun, cur); } else cur = 0;
    }
    expect(maxBlankRun, `void of ${maxBlankRun} blank rows between content and frame:\n${dump}`).toBeLessThanOrEqual(1);

    // (3) HUGS THE FRAME: last content row is within one rhythm-blank of the frame.
    let lastContentAbs = -1;
    for (let i = frameAbs - 1; i >= 0; i--) if ((lines[i] ?? '').trim() !== '') { lastContentAbs = i; break; }
    expect(frameAbs - lastContentAbs, `run does not hug the frame:\n${dump}`).toBeLessThanOrEqual(2);

    term.dispose(); statusLine.stop(); c.disarm();
  }, 20_000);
});
