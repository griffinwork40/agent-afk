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
 * 10 pre-arm rows) with AFK_DEBUG_COMPOSITOR traces showing commit 1 enter
 * topRow=11/anchorRow=11 → fitsAboveFrame=false → phase2 newTopRow=22.
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
import { createAutocompleteState } from './input/autocomplete-state.js';

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
const BANNER_ROWS = 10; // live geometry: anchorRow = 11

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

    // Banner integrity: ALL banner lines present exactly once (stale anchor
    // bookkeeping previously let commits orphan into banner rows). The LAST
    // banner row (BANNER_LINE_10) is now covered too: CupFrameRenderer's
    // `anchorFloor` param (threaded from self.anchorRow) caps the pre-commit
    // chrome-collapse shrink-pad so it can no longer climb above anchorRow and
    // blank that row (previously a known, exempted renderer defect).
    for (let i = 0; i < BANNER_ROWS; i++) {
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

  it('card body rows survive the streaming→idle collapse after mid-stream banner evictions', async () => {
    // Regression (second defect, independent of the first-commit regime-sync fix):
    // After banner-path evictions shift the committed band DOWN (as the streaming
    // overlay grows), the band model tracks the band at a position no longer adjacent
    // to the frame top recorded by logUpdate.topRow. When the overlay then CLEARS
    // (streaming ends → setOverlay('') + setSpinner(false)), the idle repaint places
    // the frame via content-following at contentFloor+1 — which is the band's
    // *current* tracked bottom + 1, so the frame top stays just above the band.
    // repositionCommittedBand sees moved=false and renderErasedBand=false (the idle
    // frame did NOT erase the band) → no re-pin, band stays at its evicted position.
    //
    // Then the response commitAbove fires. Phase 2 snaps to bottom-anchored
    // (commitInFlight=true) → the frame renders as a 1-row idle prompt at topRow=22,
    // leaving a gap between the band's tracked bottom (e.g. row 12) and newTopRow-1=21.
    // The contiguity check (`committedBandBottomRow === newTopRow - 1`) fails on this
    // gap, so Phase 3 records only the new 1-line response, dropping the entire 4-row
    // echo band from the model.
    //
    // On the NEXT repaint the CupFrameRenderer stale-tall erase wipes the rows between
    // the old tall frame top and the new idle frame top — rows that contain the echo
    // content — and repositionCommittedBand re-pins only the 1-line response model,
    // leaving the separator and body rows permanently blank.
    //
    // Scenario that reproduces the gap:
    //  • anchorRow=11, 4 echo commits (sep + body1 + body2 + blank) → band rows 17..20
    //  • overlay grows to 7 rows + spinner → banner-path evictions shift band to ~8..11,
    //    anchorRow drops to ~3
    //  • setOverlay('') + setSpinner(false) → idle repaint at contentFloor+1 (NOT 22);
    //    repositionCommittedBand: moved=false, renderErasedBand=false → no re-pin
    //  • response commitAbove fires: Phase 2 snaps to topRow=22 (gap of ~9 rows);
    //    contiguity fails → echo band dropped from model
    //  • final collapse repaint erases the echo rows (body lost, separator orphaned)
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

    // Pre-submit chrome to seat the frame below the banner (avoid idle banner-follow
    // for the very first commit — already covered by the first test in this suite).
    c.setOverlay('preflight-line');
    c.setOverlay('');

    // Echo the multi-line card (separator + body1 + body2) then blank terminator.
    const echoCard = formatSubmittedEcho({
      buffer: MESSAGE,
      promptText: 'afk (haiku)  › ',
      isTTY: true,
      terminalWidth: COLS,
    });
    const echoRows = echoCard.split('\n');
    expect(echoRows.length).toBeGreaterThanOrEqual(3);
    for (const line of echoRows) c.commitAbove(line);
    c.commitAbove(''); // blank terminator — 4 commits total, band at rows 18..21

    // Streaming phase: grow the overlay large enough to cause several banner-path
    // evictions. Each eviction shifts the committedBand downward (lower row numbers)
    // while shrinking anchorRow. A 7-line overlay causes ~3 evictions of 2+2+2=6
    // rows total, landing the band around rows 9..12 with anchorRow ~3.
    c.setSpinner({ enabled: true });
    c.setOverlay(Array.from({ length: 3 }, (_, i) => `stream ${i}`).join('\n'));
    c.setOverlay(Array.from({ length: 5 }, (_, i) => `stream ${i}`).join('\n'));
    c.setOverlay(Array.from({ length: 7 }, (_, i) => `stream ${i}`).join('\n'));

    // Streaming ends — clear overlay and spinner so the idle repaint runs
    // content-following placement (frame top = contentFloor+1 based on band bottom),
    // NOT bottom-anchored. This is the critical window: the idle repaint places the
    // frame just above the band (moved=false → no re-pin), so the band's tracked
    // position is NOT corrected back to newTopRow-1 before the response commit.
    c.setSpinner({ enabled: false });
    c.setOverlay('');

    // Response commit fires while the band is still at its evicted, non-adjacent
    // position. Phase 2 (commitInFlight=true) forces bottom-anchored placement,
    // creating the gap between band bottom and newTopRow-1. Contiguity fails →
    // echo band dropped from the model.
    c.commitAbove('RESPONSE_OK');
    // Two more repaints mirror the spinner-tick cadence that exposes the erasure.
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 800, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const ls = lines(term);
    const dump = ls.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

    const sepRows = ls.filter((l) => /─{10,}/.test(l));
    const body1Rows = ls.filter((l) => l.includes('DUPCHECK'));
    const body2Rows = ls.filter((l) => l.includes('india'));

    // Separator must appear exactly once. Under the bug it still appears (it was above
    // the streaming frame top and never overwritten) but body rows vanish entirely.
    expect(sepRows, `separator missing or duplicated:\n${dump}`).toHaveLength(1);
    // Card body must survive the streaming→idle collapse (the bug erased body1 + body2).
    expect(body1Rows, `card body row 1 lost:\n${dump}`).toHaveLength(1);
    expect(body2Rows, `card body row 2 lost:\n${dump}`).toHaveLength(1);
    // Response present exactly once.
    expect(ls.filter((l) => l.includes('RESPONSE_OK')), `response lost:\n${dump}`).toHaveLength(1);

    // Order: sep above body1 above body2 above response.
    const idx = (pred: (l: string) => boolean): number => ls.findIndex(pred);
    expect(idx((l) => /─{10,}/.test(l))).toBeGreaterThan(idx((l) => l.includes('BANNER_LINE_')));
    expect(idx((l) => l.includes('DUPCHECK'))).toBeGreaterThan(idx((l) => /─{10,}/.test(l)));
    expect(idx((l) => l.includes('india'))).toBeGreaterThan(idx((l) => l.includes('DUPCHECK')));
    expect(idx((l) => l.includes('RESPONSE_OK'))).toBeGreaterThan(idx((l) => l.includes('india')));

    statusLine.stop();
  });
});

// ─── content-hug guard in the banner-path eviction ────────────────────────────
//
// Finding (#2290): the banner-path guard at frame-preserve.ts:188-194 checks
// BOTH `overlay === ''` AND `contentHugFrameSettled(self)`.  `contentHugFrameSettled`
// returns false in content-hug mode while an autocomplete dropdown is open (or
// the compositor is in picker mode), deliberately deferring the pending-overflow
// eviction until the dropdown closes — archiving against a temporarily-enlarged
// input region would leave the band short once the dropdown collapses.
//
// This test seeds the compositor with a partially-pending band by injecting the
// internal state directly (the same pattern used by terminal-compositor.bottom-
// pin.test.ts) so the geometry is deterministic regardless of commit-path
// differences between content-hug and the non-hug overflow scenario documented
// in terminal-compositor.banner-endturn-overflow.repro.test.ts.
//
// Geometry:
//   ROWS=24, anchorRow=5 (4-row banner), no status line, no spinner.
//   At collapse: desiredTopRow = 22 (1-row frame), floor = anchorRow = 5,
//   room = 22 - 5 = 17.  Band seeded with 20 rows, paintedRows = 5 →
//   15 rows PENDING; bandLen (20) > room (17) → overflow = 3.
//   The guard fires when overlayCollapsed && contentHugFrameSettled.
//
// Mutation check (as required by issue #2290): temporarily removing the
//   `&& contentHugFrameSettled(self)` clause from the banner-path condition
//   in terminal-compositor.frame-preserve.ts causes the "dropdown open — no
//   eviction" assertion to fail because the eviction fires immediately on the
//   first repaint while the dropdown is still open (committedBandPaintedRows
//   jumps to committedBand.length = 17 survivors < 20 original, asserting
//   paintedRows < length fails).  Restoring the clause makes the test green.
describe('content-hug guard in banner-path eviction (contentHugFrameSettled)', () => {
  const CH_COLS = 80;
  const CH_ROWS = 24;
  const CH_BANNER_ROWS = 4;
  const CH_ANCHOR_ROW = CH_BANNER_ROWS + 1; // 5
  // Band geometry: 20 rows in model, only 5 painted → 15 PENDING.
  // room = desiredTopRow(22) - floor(5) = 17 < bandLen(20) → overflow = 3.
  const BAND_LEN = 20;
  const PAINTED_ROWS = 5;

  it('does not evict pending rows while an autocomplete dropdown is open; evicts once the dropdown closes', async () => {
    const acState = createAutocompleteState();
    const stdout = makeStdout(CH_COLS, CH_ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);

    // Print the banner before arming (mirrors the interactive REPL surface).
    for (let i = 0; i < CH_BANNER_ROWS; i++) stdout.write(`CH_BANNER_${i}\n`);

    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      anchorRow: CH_ANCHOR_ROW,
      contentHug: true,
      autocompleteState: acState,
    });
    await c.arm();

    // Cast to internals — mirrors the pattern in terminal-compositor.bottom-pin.test.ts.
    const internals = c as unknown as {
      repaint(): void;
      committedBandPaintedRows: number;
      committedBandArchivedPrefix: number;
      committedBand: string[];
      committedBandMeta: Array<{ logicalText: string; isHead: boolean }>;
      committedBandTopRow: number;
      committedBandBottomRow: number;
      hasCommitted: boolean;
      placementMode: string;
      overlay: string;
      anchorRow: number;
      logUpdate: { resetGeometry?(): void } | null;
    };

    // Seed the partially-pending band directly so the geometry is deterministic
    // regardless of which commit route content-hug takes.  The band represents
    // 20 model rows of which only the bottom 5 are painted; the oldest 15 are
    // PENDING.  This is the canonical banner-path overflow scenario documented in
    // terminal-compositor.banner-endturn-overflow.repro.test.ts (§ ROOT CAUSE).
    const bandRows = Array.from({ length: BAND_LEN }, (_, i) => `CH_CONTENT_${String(i).padStart(2, '0')}`);
    internals.committedBand = bandRows;
    internals.committedBandMeta = bandRows.map((t) => ({ logicalText: t, isHead: true }));
    // Physical rows: floor = CH_ANCHOR_ROW = 5.  The band's tracked span is
    //   [floor, frameTop - 1] = [5, 21]: it hugs the settled 1-row frame at
    //   desiredTopRow = 22, the same `newTopRow - 1` contract every production
    //   write site uses (commit-phase3-band.ts, commit-phase3-hold.ts). The
    //   20-row band overflows that 17-row span, which is the pending overflow
    //   under test. An earlier seed of 5 + BAND_LEN - 1 = 24 put the band ON the
    //   last terminal row, below absoluteBottom (23); production cannot reach
    //   that state and the geometry guard (I2b) rejects it. Eviction reads
    //   `room = desiredTopRow - floor`, not this field, so the fix does not
    //   change what the test exercises.
    internals.committedBandTopRow = CH_ANCHOR_ROW; // 5
    internals.committedBandBottomRow = CH_ROWS - 3; // 21 = desiredTopRow(22) - 1
    internals.committedBandPaintedRows = PAINTED_ROWS; // 5 painted; BAND_LEN(20) - PAINTED_ROWS(5) = 15 rows PENDING
    internals.hasCommitted = true;
    // content-hug: set placementMode so contentHugFrameSettled gate is active.
    internals.placementMode = 'content-hug';
    // Overlay is already '' (arm sets it empty); the frame is at idle height (1 row).
    // anchorRow is set from the constructor option; verify it matches.
    expect(internals.anchorRow, 'anchorRow must match option').toBe(CH_ANCHOR_ROW);

    // Reset the log-update renderer geometry so desiredTopRow is computed from
    // scratch on the first repaint (no stale prevTopRow).
    internals.logUpdate?.resetGeometry?.();

    // ── Phase 1: dropdown OPEN — guard must suppress banner-path eviction ────
    //
    // Open the autocomplete dropdown.  contentHugFrameSettled returns false while
    // dropdownOpen is true (in content-hug mode), so the banner-path guard
    // (`overlayCollapsedBanner = false`) must skip the eviction even though
    // overlay is '' and pending rows exist.
    acState.dropdownOpen = true;
    acState.candidates = [
      { value: '/chat', display: '/chat', icon: '' },
      { value: '/clear', display: '/clear', icon: '' },
    ];
    acState.selectedIndex = 0;

    // Fire two repaints.  The guard must hold — no eviction.
    internals.repaint();
    internals.repaint();

    // MUTATION-SENSITIVE ASSERTION: if `&& contentHugFrameSettled(self)` is
    // removed from frame-preserve.ts:188, the eviction fires here and
    // committedBandPaintedRows === committedBand.length (= 17 survivors),
    // causing this assertion to fail.
    expect(
      internals.committedBandPaintedRows,
      'dropdown open: eviction must be suppressed — pending rows must still exist',
    ).toBeLessThan(internals.committedBand.length);

    // ── Phase 2: dropdown CLOSED — guard must allow eviction ─────────────────
    //
    // Close the dropdown.  contentHugFrameSettled now returns true; the guard
    // lifts and the banner-path eviction should fire on the next repaint.
    acState.dropdownOpen = false;
    acState.candidates = [];

    internals.repaint();
    internals.repaint();

    // After eviction every row the frame cannot show is in scrollback: under
    // content-hug those rows stay in the band as the hidden ARCHIVED prefix
    // (re-shown if the frame shrinks; terminal-compositor.band-archived-prefix.ts),
    // so the invariant is "no pending row that is NOT already archived".
    const nonArchivedPending =
      internals.committedBand.length - internals.committedBandPaintedRows - internals.committedBandArchivedPrefix;
    expect(
      Math.max(0, nonArchivedPending),
      'dropdown closed: eviction must have fired — no non-archived pending rows should remain',
    ).toBe(0);

    // Feed full output into headless xterm to verify all content rows survive.
    const term = new HeadlessTerminal({
      cols: CH_COLS,
      rows: CH_ROWS,
      scrollback: 800,
      allowProposedApi: true,
      convertEol: true,
    });
    await termWrite(term, all());
    const ls = lines(term);
    const dump = ls.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

    // Every content row must appear exactly once across the full buffer.
    for (let i = 0; i < BAND_LEN; i++) {
      const label = `CH_CONTENT_${String(i).padStart(2, '0')}`;
      const hits = ls.filter((l) => l.includes(label)).length;
      expect(hits, `"${label}" must appear exactly once:\n${dump}`).toBe(1);
    }

    // Banner rows must all be intact.
    for (let i = 0; i < CH_BANNER_ROWS; i++) {
      const hits = ls.filter((l) => l.trim() === `CH_BANNER_${i}`).length;
      expect(hits, `banner row CH_BANNER_${i} must appear exactly once:\n${dump}`).toBe(1);
    }
  });
});
