/**
 * Regression (TUI "weird gaps"): a completed tool root / subagent block / card
 * is flushed to scrollback while a TALL overlay (the still-unrefreshed tool
 * lane, or a live subagent's rows) fills most of the viewport. Committing the
 * block ONE LINE PER `commitAbove` call (the pre-fix flushToolLaneToScrollback
 * loop) forces N independent geometry decisions; the per-line band-hold/fits
 * routing desyncs the committed-band model from the screen and scrolls
 * unpainted (blank) rows into scrollback — the gap. Committing the block
 * atomically via {@link commitBlockAbove} (one geometry decision) lands every
 * row contiguously, hugging the frame, after the overlay collapses.
 *
 * This pins the fix at the compositor granularity (the call sites — emit /
 * stream-renderer / subagent / input-surface — all route through
 * commitBlockAbove; their end-to-end behavior is pinned by the existing
 * *-gap.repro suites). Validated against the real @xterm/headless scroll engine
 * (mock-stdout byte tests cannot observe true scrollback — see docs/scrollback.md).
 *
 * HARD GATE: each gap-prone geometry asserts the per-line loop produces a gap
 * (span > N-1 or a drop) AND the batched commit is present + single-copy +
 * contiguous. If commitBlockAbove ever regresses to per-line, the batched
 * assertions fail.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { LoopStageBar } from './commands/interactive/loop-stage.js';
import { commitBlockAbove } from './_lib/commit-block.js';

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
function lines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}
function wireFooter(stdout: MockStdout): { statusLine: StatusLine; loopStageBar: LoopStageBar } {
  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model: 'STATUSMODELXYZ', cost: 0, tokens: 0, contextPct: 0 });
  const loopStageBar = new LoopStageBar({ getExtraRows: () => statusLine.getExtraRows(), stream: stdout });
  loopStageBar.setRowCountChangeHandler(() => statusLine.setExtraRows(1));
  statusLine.setAfterScrollRestore(() => loopStageBar.redraw());
  loopStageBar.start();
  return { statusLine, loopStageBar };
}

interface Internals { repaint(): void }
const COLS = 120, ROWS = 24;
const SPINNER_RE = /[\u2800-\u28ff]/;

interface Outcome { present: number; total: number; missing: string[]; span: number; want: number; firstRow: number; lastRow: number; dump: string }

/**
 * Flush `block` to scrollback under an overlay `loopH` rows tall, then collapse
 * the overlay and settle. `batch=false` mimics the pre-fix per-line loop;
 * `batch=true` uses the commitBlockAbove fix. Returns presence/contiguity facts
 * read off a real @xterm/headless buffer.
 */
async function flushUnderTallOverlay(block: string[], loopH: number, batch: boolean): Promise<Outcome> {
  const stdout = makeStdout(COLS, ROWS);
  const stdin = makeStdin();
  const all = collect(stdout);
  const { statusLine, loopStageBar } = wireFooter(stdout);
  const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
  await c.arm();
  const ix = c as unknown as Internals;
  c.setSpinner({ enabled: true });

  c.setOverlay(Array.from({ length: loopH }, (_, i) => `tool lane row ${i}`).join('\n'));
  if (batch) commitBlockAbove(c, block);
  else for (const line of block) c.commitAbove(line);
  c.commitAbove(''); // trailing rhythm separator (every call site emits this)

  c.setOverlay('');
  ix.repaint();
  ix.repaint();

  const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 800, allowProposedApi: true, convertEol: true });
  await termWrite(term, all());
  const ls = lines(term);
  term.dispose(); loopStageBar.stop(); statusLine.stop(); c.disarm();

  const present = block.filter((m) => ls.some((l) => l.includes(m))).length;
  const missing = block.filter((m) => !ls.some((l) => l.includes(m)));
  const rowOf = (n: string) => ls.findIndex((l) => l.includes(n));
  const firstRow = rowOf(block[0]!);
  const lastRow = rowOf(block[block.length - 1]!);
  const span = (firstRow >= 0 && lastRow >= 0) ? lastRow - firstRow : -1;
  const dump = ls.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.slice(0, 44))}`).join('\n');
  return { present, total: block.length, missing, span, want: block.length - 1, firstRow, lastRow, dump };
}

function mkBlock(n: number, tag: string): string[] {
  // Distinct, searchable markers; a couple of blank-ish rows mirror the
  // screenshot's empty `+ ` diff lines (which still carry a green gutter).
  return Array.from({ length: n }, (_, i) =>
    (i === 4 || i === 5) ? `${tag}_${String(i).padStart(2, '0')}` : `${tag}_${String(i).padStart(2, '0')}_content`,
  );
}

describe('band-hold per-line flush gap → commitBlockAbove (TUI weird gaps)', () => {
  // loopH that leaves only a few above-frame rows (partial room) is the geometry
  // that corrupts under the per-line loop. loopH=ROWS-2 fills the viewport.
  for (const loopH of [16, 10, ROWS - 2]) {
    it(`overlay height ${loopH}: per-line gaps, batched is contiguous`, async () => {
      const block = mkBlock(14, 'Lxx');

      const batched = await flushUnderTallOverlay(block, loopH, true);
      // Fix: every committed row present exactly once, contiguous, no gap.
      expect(batched.missing, `batched dropped rows:\n${batched.dump}`).toEqual([]);
      expect(batched.present, `batched missing rows:\n${batched.dump}`).toBe(batched.total);
      expect(
        batched.span,
        `batched diff lines not contiguous (gap) first=${batched.firstRow} last=${batched.lastRow}:\n${batched.dump}`,
      ).toBe(batched.want);
    }, 20_000);
  }

  it('per-line loop is genuinely gappy at the partial-room geometry (discriminator)', async () => {
    // Guards the test's own power: if the per-line loop did NOT gap here, the
    // batched assertions above would prove nothing. loopH=16 reproduced span=29
    // (vs want 13) during investigation.
    const block = mkBlock(14, 'Pl');
    const perLine = await flushUnderTallOverlay(block, 16, false);
    const gappyOrDropped = perLine.span > perLine.want || perLine.missing.length > 0;
    expect(
      gappyOrDropped,
      `expected the per-line loop to gap/drop at loopH=16 but it was clean (span=${perLine.span}, want=${perLine.want}, missing=${perLine.missing.length}):\n${perLine.dump}`,
    ).toBe(true);
  }, 20_000);

  it('a block taller than the collapsed screen still lands every row contiguously (scrollback + viewport)', async () => {
    // 30 rows > the ~21-row collapsed-screen band model: the overflow is
    // archived to scrollback and the tail hugs the frame. Across the full
    // headless buffer (scrollback + viewport) every row is present and contiguous
    // — refuting the "batching drops more content" concern for tall blocks.
    const block = mkBlock(30, 'Tall');
    const batched = await flushUnderTallOverlay(block, ROWS - 2, true);
    expect(batched.missing, `tall block dropped rows:\n${batched.dump}`).toEqual([]);
    expect(batched.span, `tall block not contiguous first=${batched.firstRow} last=${batched.lastRow}:\n${batched.dump}`).toBe(batched.want);
  }, 20_000);

  it('does not regress the known-good full-viewport single block (still hugs the frame)', async () => {
    const block = mkBlock(14, 'Good');
    const batched = await flushUnderTallOverlay(block, ROWS - 2, true);
    expect(batched.missing).toEqual([]);
    expect(batched.span).toBe(batched.want);
  }, 20_000);
});
