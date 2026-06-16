/**
 * Regression: a MULTI-LINE block (a rendered markdown table) committed via
 * commitAbove() while a tall overlay is held up — and then the overlay collapses
 * — must not (a) duplicate the block (one truncated on-screen copy + one full
 * scrollback copy) nor (b) leave a multi-row blank gap between the committed
 * content and the live frame in the final viewport.
 *
 * This is the !fitsAboveFrame OVERFLOW path (terminal-compositor.ts), which #645
 * explicitly left unchanged ("the overflow path is unchanged", docs/scrollback.md).
 * The screenshot symptom: a table renders its header + divider, then a large
 * blank gap swallows the body rows, and later content (Evidence) resumes far
 * below — plus the header appears twice.
 *
 * Pre-fix: header appears TWICE (full scrollback copy + truncated on-screen
 * copy) and a multi-row blank gap opens above the band after collapse.
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

// A realistic diagnosis-summary markdown table (mirrors the screenshot columns).
const TABLE_MD = [
  '| # | Change | File | Nature |',
  '|---|--------|------|--------|',
  '| 1 | pass cwd to scheduler | scheduler.ts | behavior |',
  '| 2 | load config from cwd | config-loader.ts | behavior |',
  '| 3 | thread cwd through daemon | daemon.ts | plumbing |',
].join('\n');

describe('commitAbove overflow-path table gap regression (tall overlay, extraRows=2)', () => {
  it('commits a multi-line table under a tall overlay without duplicate or blank gap', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    // Production footer: StatusLine + LoopStageBar + VerdictLedger → extraRows=2.
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });

    const tableText = renderMarkdownToTerminal(TABLE_MD, { width: COLS });
    const tableLineCount = tableText.replace(/\n$/, '').split('\n').length;

    // A persistent tall overlay (heavy tool-lane / thinking activity) held up
    // across every commit — the trigger for the overflow path.
    const tallOverlay = Array.from({ length: 14 }, (_, i) => `thinking ${i} — dispatched subagent, verifying claim ${i}`).join('\n');

    // Mirror the production "Done" report streamed as blocks while the overlay
    // stays tall (markdown-stream commits each block as `text + '\n\n'`).
    c.setOverlay(tallOverlay);
    c.commitAbove('Diagnosis complete\n\n');
    c.setOverlay(tallOverlay);
    c.commitAbove('What I diagnosed: the TUI rendering defect in your screenshot.\n\n');
    c.setOverlay(tallOverlay);
    c.commitAbove(tableText.replace(/\n$/, '') + '\n\n');
    c.setOverlay(tallOverlay);
    c.commitAbove('Evidence (deterministic, reproduced): header + divider render, then a gap.\n\n');

    // The overlay collapses (turn ends → spinner stops, overlay clears).
    c.setOverlay('');
    const internals = c as unknown as { repaint(): void };
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    const SPINNER_RE = /[\u2800-\u28ff]/; // braille spinner glyphs
    const baseY = term.buffer.active.baseY; // first viewport row index
    const view = lines.slice(baseY);
    const frameIdx = view.findIndex((l) => SPINNER_RE.test(l));
    expect(frameIdx, `frame (spinner) not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(0);

    // (1) NO DUPLICATE: the table header ("Change" + "Nature") appears exactly
    //     once across the whole buffer (scrollback + viewport). Pre-fix the
    //     overflow path archived the block to scrollback AND painted a truncated
    //     on-screen copy → the header showed up twice.
    const headerHits = lines.map((l, i) => (l.includes('Change') && l.includes('Nature') ? i : -1)).filter((i) => i >= 0);
    expect(
      headerHits.length,
      `table header must appear exactly once (found ${headerHits.length}); tableLineCount=${tableLineCount}:\n${dump}`,
    ).toBe(1);

    // (2) VISIBLE + INTACT: the report fits the collapsed screen, so the whole
    //     table (header + all three body rows) must be present IN THE VIEWPORT —
    //     not pushed to scrollback, not truncated. Pre-fix the body rows were
    //     swallowed by the void / stranded in scrollback.
    const wantInView = [
      'Change', // header
      'pass cwd to scheduler', // body 1
      'load config from cwd', // body 2
      'thread cwd through daemon', // body 3
      'Diagnosis complete', // prose before the table
      'Evidence (deterministic', // prose after the table
    ];
    for (const needle of wantInView) {
      const inView = view.slice(0, frameIdx).filter((l) => l.includes(needle)).length;
      expect(inView, `"${needle}" must appear exactly once in the viewport above the frame:\n${dump}`).toBe(1);
    }

    // (3) CONTIGUOUS, NO VOID: between the first non-blank content row and the
    //     frame there must be no run of >= 2 consecutive blank rows (one blank is
    //     the legit rhythm separator between committed blocks). This is the
    //     screenshot's "massive void" between the header and the body rows.
    const firstContent = view.findIndex((l) => l.trim() !== '');
    let maxBlankRun = 0, cur = 0;
    for (let i = Math.max(0, firstContent); i < frameIdx; i++) {
      if ((view[i] ?? '').trim() === '') { cur++; maxBlankRun = Math.max(maxBlankRun, cur); }
      else cur = 0;
    }
    expect(
      maxBlankRun,
      `blank gap of ${maxBlankRun} rows in viewport between content and frame (baseY=${baseY} frameIdx=${frameIdx} firstContent=${firstContent}):\n${dump}`,
    ).toBeLessThanOrEqual(1);

    // (4) HUGS THE FRAME: the committed run's last content row sits immediately
    //     above the frame (the bottom-anchored "input pinned, content rises"
    //     geometry), with at most the one rhythm-separator blank between them.
    const lastContent = (() => { for (let i = frameIdx - 1; i >= 0; i--) if ((view[i] ?? '').trim() !== '') return i; return -1; })();
    expect(
      frameIdx - lastContent,
      `committed run does not hug the frame (lastContent=${lastContent} frame=${frameIdx}):\n${dump}`,
    ).toBeLessThanOrEqual(2);

    term.dispose(); statusLine.stop(); c.disarm();
  }, 15_000);
});

/**
 * Regression (Codex PR #649 P1): the band-hold path must not lose committed
 * rows when streaming commits push the run past `maxBandModel` while a tall
 * overlay is still held up.
 *
 * Geometry (re-derived against running code, not the diff): ROWS=24,
 * extraRows=2, anchorRow=1, a 17-line overlay held across every commit pins
 * the frame top at row 2 → room=1 (one visible above-frame row) and
 * maxBandModel=20. Committing one-content-line blocks (`"Rxx\n\n"` →
 * ['Rxx',''] = 1 content + 1 rhythm-separator blank) grows the band-hold MODEL
 * by 2 rows per commit; only the bottom 1 is painted (room=1), the rest are
 * "pending" — in the model, never on screen, never in scrollback. After 10
 * such commits the model holds exactly 20 rows = maxBandModel.
 *
 * The bug: an 11th commit makes `overflowRun.length` = 20 + 2 = 22 >
 * maxBandModel=20, which on HEAD flips `useBandHold` to false EVEN THOUGH
 * `overflowHasPending` is true. The fits path (fitsAboveFrame, since the new
 * block fits room=1's first line) then computes its scroll count from
 * `committedBand.length` (20) and emits ~20 line-feeds — but only 1 of those
 * rows was ever painted, so ~19 BLANK rows scroll into scrollback while
 * Phase 3's cap (`run.slice(-maxRun)`) drops the ~19 pending real rows on the
 * false premise they reached scrollback. Most of the streamed report vanishes
 * — exactly the lost-table symptom the fits-path comment at
 * terminal-compositor.ts ~1216-1228 already documents for a different trigger.
 *
 * A run genuinely taller than the collapsed screen (overflowRun.length truly
 * exceeds maxBandModel) is legitimately off-screen and SHOULD archive its
 * OVERFLOW (the oldest rows) to scrollback — but it must archive REAL content,
 * never blanks, and must not drop or duplicate rows. After the overlay
 * collapses, every committed row must be present exactly once across the whole
 * buffer (oldest in scrollback, the rest visible in the viewport), the header
 * must appear exactly once, and the run must hug the frame with no >=2-row void.
 *
 * Isolation note: to test ONLY the band-hold cap/routing mechanism the finding
 * names — and NOT the separate, pre-existing fact that maxBandModel can exceed
 * the room a NON-minimal collapsed frame leaves (repositionCommittedBand paints
 * but does not evict that excess) — the overlay collapse here also stops the
 * spinner, leaving a 1-row collapsed frame so the above-frame room at collapse
 * (20) equals maxBandModel (20). That keeps the assertion focused on the
 * reported pending-row loss; the collapsed-frame-height gap is out of scope for
 * this fix.
 */
describe('commitAbove band-hold cap (run exceeds maxBandModel while a tall overlay is held)', () => {
  it('archives the genuine overflow to scrollback instead of stranding pending rows', async () => {
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

    // 17-line overlay → frame top pinned at row 2 → room=1, maxBandModel=20.
    // (overlay 17 + spinner 1 + gap 1 + input 1 = 20 frame rows;
    //  desiredTopRow = max(1, (24-1-2) - 20 + 1) = 2.)
    const tallOverlay = Array.from(
      { length: 17 },
      (_, i) => `thinking ${i} — held overlay row ${i} keeping the frame tall`,
    ).join('\n');

    // Stream a "report" as blocks while the overlay stays tall. Each block is
    // committed with the trailing '\n\n' that markdown-stream uses per block,
    // so a single-content-line block ("Rxx\n\n") contributes 2 MODEL rows
    // (1 content + 1 rhythm-separator blank) and an N-line block contributes
    // N+1. Unique Rxx labels let us assert NO row is lost or duplicated. The
    // first block carries a "HEADER-MARKER" sentinel (the table-header
    // single-copy invariant). One block is a contiguous 3-row "table" to mirror
    // the screenshot's rendered table.
    //
    // We size the accumulation to leave the band-hold model at EXACTLY
    // maxBandModel=20 rows BEFORE the transition commit, so the transition
    // (+2 rows) makes overflowRun=22 > maxBandModel — the precise condition the
    // finding names. Layout (model-row running total):
    //   header (1+1)            → 2
    //   4 prose (4×(1+1))       → 10
    //   table  (3+1)            → 14
    //   3 prose (3×(1+1))       → 20   ← model == maxBandModel
    const internals = c as unknown as {
      repaint(): void;
      committedBand: string[];
    };
    const reportRows: string[] = [];
    const commit = (s: string): void => {
      c.setOverlay(tallOverlay); // re-arm the held overlay before each commit
      c.commitAbove(s);
    };
    const prose = (label: string): void => {
      const row = `${label} prose row of the streamed report`;
      reportRows.push(row);
      commit(`${row}\n\n`);
    };
    // Block 0: a header line (sentinel) — label R00.
    reportRows.push('HEADER-MARKER R00 — Diagnosis summary');
    commit('HEADER-MARKER R00 — Diagnosis summary\n\n');
    // Blocks 1-4: prose rows R01..R04.
    for (let i = 1; i <= 4; i++) prose(`R${String(i).padStart(2, '0')}`);
    // Block 5: a contiguous 3-row "table" committed as ONE block (the
    // screenshot's rendered table — header+divider+row arrive together).
    const tableRows = [
      'R05 | Change                | File             |',
      'R06 |-----------------------|------------------|',
      'R07 | pass cwd to scheduler | scheduler.ts     |',
    ];
    reportRows.push(...tableRows);
    commit(`${tableRows.join('\n')}\n\n`);
    // Blocks 6-8: prose rows R08..R10, bringing the model to exactly 20.
    for (let i = 8; i <= 10; i++) prose(`R${String(i).padStart(2, '0')}`);

    // Precondition (locks the geometry against drift): the band-hold model is
    // now full at exactly maxBandModel=20, with only the bottom row painted
    // (room=1) and the other 19 pending. If this ever changes the test's
    // premise is invalid and the assertions below would silently stop covering
    // the finding — so assert it explicitly.
    expect(
      internals.committedBand.length,
      'precondition: band-hold model must be full at maxBandModel=20 before the transition commit',
    ).toBe(20);

    // The transition commit: one more block under the STILL-held overlay.
    // overflowRun = 20 + 2 = 22 > maxBandModel=20. On HEAD this flips
    // useBandHold false → the fits path scrolls ~19 unpainted (blank) rows into
    // scrollback and drops the pending real rows (band collapses to just this
    // line). With the fix the commit stays in band-hold and archives the
    // genuine overflow (oldest rows) as real content to scrollback.
    reportRows.push('TRANSITION-LINE the streaming commit after the band filled');
    commit('TRANSITION-LINE the streaming commit after the band filled\n\n');

    // The overlay collapses (turn ends → spinner stops, overlay clears). Stop
    // the spinner so the collapsed frame is 1 row (input only): the above-frame
    // room at collapse (20) then equals maxBandModel (20), isolating the
    // band-hold cap mechanism from the separate collapsed-frame-height gap.
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    // With the spinner stopped the collapsed frame is the single input row,
    // which renders the `⎯` rule (U+23AF) — used as the frame anchor.
    const FRAME_RE = /\u23af/; // the input row's horizontal-rule glyph
    const baseY = term.buffer.active.baseY;
    const view = lines.slice(baseY);
    const frameIdx = view.findIndex((l) => FRAME_RE.test(l));
    expect(frameIdx, `frame (input rule) not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(0);

    // (1) NO DATA LOSS / NO DUPLICATE: every committed report row carries a
    //     unique R<dd> label (R00..R10) and must be present EXACTLY ONCE across
    //     the whole buffer (scrollback + viewport) — oldest rows archived to
    //     scrollback, the rest visible in the viewport. Pre-fix most rows vanish
    //     (scrolled as blanks then dropped by the cap).
    for (const row of reportRows) {
      const m = row.match(/R\d\d/); // the unique R<dd> label
      if (!m) continue; // the TRANSITION-LINE row has no Rxx label — covered below
      const label = m[0];
      const hits = lines.filter((l) => l.includes(label)).length;
      expect(hits, `report row ${label} must be present exactly once across the whole buffer (found ${hits}):\n${dump}`).toBe(1);
    }
    const transHits = lines.filter((l) => l.includes('TRANSITION-LINE')).length;
    expect(transHits, `the transition line must be present exactly once across the whole buffer (found ${transHits}):\n${dump}`).toBe(1);

    // (2) NO DUPLICATE header: the sentinel appears exactly once buffer-wide.
    const headerHits = lines.filter((l) => l.includes('HEADER-MARKER')).length;
    expect(headerHits, `HEADER-MARKER must appear exactly once (found ${headerHits}):\n${dump}`).toBe(1);

    // (3) VISIBLE + INTACT IN VIEWPORT: the newest rows (everything after the
    //     oldest few that legitimately archive to scrollback) must be visible
    //     above the frame. Assert the transition line and the last few report
    //     rows appear in the viewport above the frame exactly once.
    const wantInView = [
      'TRANSITION-LINE',
      'R10 prose',
      'R09 prose',
      'R07 | pass cwd to scheduler', // last table row
    ];
    for (const needle of wantInView) {
      const inView = view.slice(0, frameIdx).filter((l) => l.includes(needle)).length;
      expect(inView, `"${needle}" must appear exactly once in the viewport above the frame:\n${dump}`).toBe(1);
    }

    // (4) NO BLANK VOID: pre-fix ~19 BLANK rows were scrolled into scrollback in
    //     place of real content. Assert no run of >= 2 consecutive blank rows
    //     between the first non-blank row and the frame (one blank is the
    //     per-block rhythm separator).
    const firstContentAbs = lines.findIndex((l) => l.trim() !== '');
    const frameAbs = baseY + frameIdx;
    let maxBlankRun = 0, cur = 0;
    for (let i = Math.max(0, firstContentAbs); i < frameAbs; i++) {
      if ((lines[i] ?? '').trim() === '') { cur++; maxBlankRun = Math.max(maxBlankRun, cur); }
      else cur = 0;
    }
    expect(
      maxBlankRun,
      `blank gap of ${maxBlankRun} rows between content and frame (firstContent=${firstContentAbs} frame=${frameAbs} baseY=${baseY}):\n${dump}`,
    ).toBeLessThanOrEqual(1);

    // (5) HUGS THE FRAME: the most-recent committed row (the transition line)
    //     sits immediately above the frame, with at most one rhythm-separator
    //     blank between them.
    const lastContent = (() => { for (let i = frameIdx - 1; i >= 0; i--) if ((view[i] ?? '').trim() !== '') return i; return -1; })();
    expect(
      frameIdx - lastContent,
      `committed run does not hug the frame (lastContent=${lastContent} frame=${frameIdx}):\n${dump}`,
    ).toBeLessThanOrEqual(2);

    term.dispose(); statusLine.stop(); c.disarm();
  }, 15_000);
});
