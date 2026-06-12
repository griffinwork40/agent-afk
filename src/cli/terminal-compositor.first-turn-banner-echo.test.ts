/**
 * Regression (first turn after the banner): the FIRST commitAbove of an arm
 * cycle fires while the idle frame is banner-followed (frame placement's
 * `hasBanner && !commitInFlight` regime puts the prompt just below the
 * banner → zero above-frame room), but the commit itself executes in the
 * bottom-anchored regime (Phase 2 repaints with commitInFlight=true). The
 * room calculation used the pre-flip topRow, misrouting the commit into the
 * overflow path:
 *
 *   - Phase 1 "archived" the block ON SCREEN at anchorFloor — with a banner
 *     that is an untracked orphan row, not a scrollback write (copy #1),
 *   - Phase 3 painted it again at anchorFloor (copy #2) while recording the
 *     band at the bottom-anchored rows it never painted,
 *   - the next commit's merge then repainted the phantom band one row up
 *     (copy #3), and the stale anchorRow (overflow sets scrolledRows=0)
 *     under-protected the real rows when streaming growth evicted — the
 *     card body was overwritten by the growing frame.
 *
 * User-visible symptom: submitting the first message echoed the card's
 * FIRST line (the separator rule) twice near the top while the card body
 * vanished under the streaming frame. Reproduced live in tmux (80×24,
 * 11 pre-arm rows) with AFK_DEBUG_COMPOSITOR traces showing commit 1 enter
 * topRow=12/anchorRow=12 → fitsAboveFrame=false → phase2 newTopRow=22.
 *
 * Fix (terminal-compositor.committed-band-commit.ts): when a banner is
 * active and the band is empty, flip commitInFlight and clear+repaint
 * BEFORE measuring room, so every phase of the commit sees the same
 * (bottom-anchored) geometry.
 *
 * Every other banner-path test commits with a tall overlay already up
 * (frame bottom-ish), so this idle-frame first-commit geometry was
 * uncovered. Harness pattern follows banner-commit-gap.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { LoopStageBar } from './commands/interactive/loop-stage.js';
import { formatSubmittedEcho } from './input/echo.js';

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

function wireFooter(stdout: MockStdout): StatusLine {
  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model: 'STATUSMODELXYZ', cost: 0, tokens: 0, contextPct: 0 });
  const loopStageBar = new LoopStageBar({ getExtraRows: () => statusLine.getExtraRows(), stream: stdout });
  loopStageBar.setRowCountChangeHandler(() => statusLine.setExtraRows(1));
  statusLine.setAfterScrollRestore(() => loopStageBar.redraw());
  loopStageBar.start();
  return statusLine;
}

const COLS = 80;
const ROWS = 24;
const BANNER_ROWS = 11; // live geometry: anchorRow = 12

const MESSAGE =
  'Reply with only the word ok and nothing else. DUPCHECK alpha bravo charlie delta echo foxtrot golf hotel india';

describe('first turn after banner — idle banner-followed frame commit', () => {
  it('commits the echo card exactly once and the body survives streaming growth', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);

    // Pre-arm banner, exactly like the interactive surface.
    for (let i = 0; i < BANNER_ROWS; i++) stdout.write(`BANNER_LINE_${i}\n`);

    const statusLine = wireFooter(stdout);
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: BANNER_ROWS + 1,
    });
    await c.arm();
    const internals = c as unknown as { repaint(): void };

    // Pre-submit chrome cycle: the REPL renders transient chrome (spinner,
    // hint row, preflight line) and collapses back to idle before the user's
    // first submit. The collapse leaves CupFrameRenderer's shrink-pad state
    // deflating logUpdate.topRow by the shrink delta (commit.ts documents the
    // deflation; its `effectiveFrameTop` correction is gated on a NON-EMPTY
    // band, so the FIRST commit had no correction). A 1-row delta reproduces
    // the live trace exactly: topRow 13 → 12 == anchorRow, measured
    // above-frame room 0, and the commit misroutes into the overflow path.
    c.setOverlay('preflight-line');
    c.setOverlay('');

    // First turn: NO overlay is up — the idle frame is banner-followed.
    // Echo the submitted message through the REAL card path and commit it
    // per-line, mirroring input-surface.ts (split + commitAbove per row),
    // then the turn-handler's blank-line commit.
    const echo = formatSubmittedEcho({
      buffer: MESSAGE,
      promptText: 'afk (haiku)  › ',
      isTTY: true,
      terminalWidth: COLS,
    });
    const echoRows = echo.split('\n');
    expect(echoRows.length).toBeGreaterThanOrEqual(3); // separator + ≥2 body rows
    for (const line of echoRows) c.commitAbove(line);
    c.commitAbove('');

    // Streaming: spinner + overlay growth past the band (the phase that
    // overwrote the card body when the band/anchor bookkeeping was stale),
    // then a response commit and collapse back to idle.
    c.setSpinner({ enabled: true });
    for (let g = 2; g <= 14; g += 3) {
      c.setOverlay(Array.from({ length: g }, (_, i) => `stream-row ${g}.${i}`).join('\n'));
    }
    c.commitAbove('RESPONSE_OK');
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 800, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const ls = lines(term);
    const dump = ls.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

    const sepRows = ls.filter((l) => /─{10,}/.test(l));
    const body1Rows = ls.filter((l) => l.includes('DUPCHECK'));
    const body2Rows = ls.filter((l) => l.includes('india'));

    // The card's first line (separator) must appear exactly once — the bug
    // produced 2–3 copies (Phase-1 orphan + Phase-3 anchorFloor paint +
    // next-commit merge repaint).
    expect(sepRows, `separator duplicated:\n${dump}`).toHaveLength(1);
    // The card body must survive streaming growth — the bug erased it.
    expect(body1Rows, `card body row 1 lost/duplicated:\n${dump}`).toHaveLength(1);
    expect(body2Rows, `card body row 2 lost/duplicated:\n${dump}`).toHaveLength(1);
    // Response present exactly once below the echo.
    expect(ls.filter((l) => l.includes('RESPONSE_OK'))).toHaveLength(1);

    // Order: banner above separator above body above response.
    const idx = (pred: (l: string) => boolean): number => ls.findIndex(pred);
    const lastBanner = ls.reduce((acc, l, i) => (l.includes('BANNER_LINE_') ? i : acc), -1);
    expect(lastBanner).toBeGreaterThanOrEqual(0);
    expect(idx((l) => /─{10,}/.test(l)), `separator above banner:\n${dump}`).toBeGreaterThan(lastBanner);
    expect(idx((l) => l.includes('DUPCHECK'))).toBeGreaterThan(idx((l) => /─{10,}/.test(l)));
    expect(idx((l) => l.includes('india'))).toBeGreaterThan(idx((l) => l.includes('DUPCHECK')));
    expect(idx((l) => l.includes('RESPONSE_OK'))).toBeGreaterThan(idx((l) => l.includes('india')));

    // Banner integrity: banner lines still present exactly once (stale
    // anchor bookkeeping previously let commits orphan into banner rows).
    // Exemption — the LAST banner row (BANNER_LINE_10): the pre-commit
    // chrome collapse's shrink-pad climbs above anchorRow and blanks it
    // BEFORE any commit fires (probe: collapse alone leaves topRow=11 and
    // row 11 erased, no commitAbove involved). That is a separate
    // pre-existing renderer defect (shrink-pad has no anchorRow floor) —
    // out of scope for the commit-geometry fix this file guards. In
    // production the observed deflation is 1 row, landing on the blank
    // row below the banner, so it is not user-visible today.
    for (let i = 0; i < BANNER_ROWS - 1; i++) {
      expect(ls.filter((l) => l.trim() === `BANNER_LINE_${i}`), `banner row ${i}:\n${dump}`).toHaveLength(1);
    }

    statusLine.stop();
  });

  it('second message after idle (band emptied by eviction) also commits exactly once', async () => {
    // Guards the gate choice: the regime-sync must key on BAND EMPTY (not a
    // once-per-arm flag) — growth eviction can empty the band mid-session,
    // returning idle placement to banner-following for the next commit.
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    for (let i = 0; i < BANNER_ROWS; i++) stdout.write(`BANNER_LINE_${i}\n`);
    const statusLine = wireFooter(stdout);
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: BANNER_ROWS + 1,
    });
    await c.arm();
    const internals = c as unknown as { repaint(): void };

    // Turn 1: idle-frame echo commit, response while chrome is modest, then
    // heavy growth (no commits while the frame fills the viewport — that is
    // the separately-tested park/promote path) so eviction EMPTIES the band,
    // then collapse. The collapse leaves shrink-pad deflation AND an empty
    // band — the exact first-commit geometry, recreated mid-session.
    c.commitAbove('TURN_ONE_ECHO');
    c.commitAbove('');
    c.setSpinner({ enabled: true });
    c.setOverlay('t1-stream 0\nt1-stream 1');
    c.commitAbove('TURN_ONE_RESPONSE');
    c.setOverlay(Array.from({ length: 20 }, (_, i) => `t1-stream ${i}`).join('\n'));
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();

    // Turn 2 from idle again (band emptied by the growth eviction above).
    c.commitAbove('TURN_TWO_ECHO');
    c.commitAbove('');
    c.setSpinner({ enabled: true });
    c.setOverlay(Array.from({ length: 6 }, (_, i) => `t2-stream ${i}`).join('\n'));
    c.commitAbove('TURN_TWO_RESPONSE');
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 800, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const ls = lines(term);
    const dump = ls.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

    for (const marker of ['TURN_ONE_ECHO', 'TURN_ONE_RESPONSE', 'TURN_TWO_ECHO', 'TURN_TWO_RESPONSE']) {
      expect(ls.filter((l) => l.includes(marker)), `${marker}:\n${dump}`).toHaveLength(1);
    }
    expect(ls.findIndex((l) => l.includes('TURN_TWO_ECHO')))
      .toBeGreaterThan(ls.findIndex((l) => l.includes('TURN_ONE_RESPONSE')));

    statusLine.stop();
  });
});
