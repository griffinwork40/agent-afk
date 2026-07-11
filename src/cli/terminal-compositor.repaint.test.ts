/**
 * Tests for TerminalCompositor — repaint + commitAbove + anchorRow.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369);
 * these were nested describes under the top-level TerminalCompositor suite.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { CupFrameRenderer } from './cup-frame-renderer.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

describe('TerminalCompositor — repaint + commitAbove + anchorRow', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
    // Reset the process-wide StdinClaim singleton so each test starts clean.
    __resetStdinClaimForTests();
  });

  describe('repaint composition', () => {
    it('setOverlay writes overlay text to stdout', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setOverlay('OVERLAY_TEXT');
      expect(writes.all()).toContain('OVERLAY_TEXT');
    });

    it('typing a printable char causes repaint to include the buffer', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      expect(writes.all()).toContain('hi');
    });

    it('empty overlay renders only input line (no leading blank)', async () => {
      // Idle state — no overlay, no spinner, no tip, no attachment — must
      // not pad above the prompt. With rows=24 the input lands at row 23
      // and no other row should be written. CupFrameRenderer emits one
      // `\x1b[<row>;1H\x1b[2K<content>` block per frame line; verify the
      // row just above input (row 22) is NOT written.
      stdout.rows = 24;
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), promptText: '> ' });
      await c.arm();
      const firstFrame = writes.all();
      expect(firstFrame).toContain('> ');
      // No write to row 22 — would indicate a gap row or other chrome.
      expect(firstFrame).not.toContain('\x1b[22;1H');
    });

    it('non-empty overlay inserts a blank row between overlay and the input cluster', async () => {
      // Visual breathing room: the input prompt is the user's surface and
      // should not sit flush against agent-activity chrome. When ANY content
      // (overlay/spinner/tip/attachment) renders above input, the frame
      // separates them with a single blank row (the gap sits between the
      // chrome region and the dropdown→hint→input bottom cluster).
      //
      // With rows=24 and a single-line overlay, frame = [overlay, gap, input]
      // → newTopRow = 21. Row 21 = overlay, row 22 = empty gap, row 23 =
      // input. Assert by locating the overlay text and the input prompt and
      // confirming the gap row's CUP+ERASE (with no content between it and
      // the next CUP for the input row) sits between them.
      stdout.rows = 24;
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), promptText: '> ' });
      await c.arm();
      writes.clear();
      c.setOverlay('OVERLAY_LAST_LINE');
      const out = writes.all();
      // CupFrameRenderer writes one CUP+ERASE+content per frame line, so byte
      // order in the captured stream reflects top-to-bottom row order.
      const overlayIdx = out.indexOf('OVERLAY_LAST_LINE');
      const inputIdx = out.lastIndexOf('> ');
      expect(overlayIdx).toBeGreaterThanOrEqual(0);
      expect(inputIdx).toBeGreaterThan(overlayIdx);
      // The gap row's CUP+ERASE pair must appear between the overlay and the
      // input row write — i.e., `\x1b[22;1H\x1b[2K` followed immediately by
      // a CUP for row 23. This is the empty content slot CupFrameRenderer
      // emits for the blank gap line.
      const gapPattern = '\x1b[22;1H\x1b[2K\x1b[23;1H';
      expect(out).toContain(gapPattern);
      const gapIdx = out.indexOf(gapPattern);
      expect(gapIdx).toBeGreaterThan(overlayIdx);
      expect(gapIdx).toBeLessThan(inputIdx);
    });
  });

  describe('commitAbove', () => {
    it('writes the committed text + scroll N times when armed', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('COMMITTED_BLOCK');
      const out = writes.all();
      // Text is present in the byte stream (Phase 3 CUP write above the frame).
      expect(out).toContain('COMMITTED_BLOCK');
      // Phase 3 positions the text immediately above the live frame.
      // With a 1-line idle frame and rows=24, newTopRow=23, so text lands at row 22.
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2KCOMMITTED_BLOCK/);
      // Phase 1 emits bottom-margin scrolls only when existing band content
      // would overflow above-frame room (bandOverflow > 0). On the first
      // commit with an empty band the above-frame room (22 rows) is larger
      // than lineCount (1), so bandOverflow=0 and no LF fires — no blank
      // rows enter scrollback. The content enters scrollback naturally when
      // a later commit or overlay growth evicts it.
    });

    it('when not armed, writes directly without invoking log-update', () => {
      // Unarmed path: writeWithGuard short-circuits (no scrollRegion
      // configured), so the inner write is invoked verbatim. Text and \n
      // appear adjacent.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      c.commitAbove('ORPHAN_BLOCK');
      expect(writes.all()).toContain('ORPHAN_BLOCK\n');
    });

    it('with spinner active, commits text and renders exactly one spinner frame', async () => {
      // Regression: a re-entrant repaint() during the clear→write window
      // would strand a stale spinner frame in scrollback while repaint()
      // drew a second live frame below it, producing two visible spinners.
      // The `committing` guard suppresses repaint during that window.
      //
      // Single-copy contract (post-dedup fix): committed text appears EXACTLY
      // ONCE in the byte stream. The old dual-write (Phase 1 text + Phase 3
      // text) caused each committed block to appear twice in scrollback — the
      // "Done card rendered twice" regression. The fix: Phase 1 emits only
      // LF scrolls (no text); Phase 3 paints the single copy above the live
      // frame. Durability (surviving later overlay growth) is handled by
      // evict-on-growth in repaint(), which is gated on hasCommitted so it
      // only fires when transcript content actually exists above the frame.
      const BRAILLE_FRAME_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setSpinner({ enabled: true });
      writes.clear();
      c.commitAbove('COMMITTED_BLOCK');
      const out = writes.all();
      // Single-copy: committed text appears exactly once (Phase 3 only).
      expect(out.match(/COMMITTED_BLOCK/g)?.length).toBe(1);
      // Phase 1 emits LFs only when bandOverflow > 0 (existing band overflows
      // above-frame room). First commit with empty band: bandOverflow=0, no LF.
      // Exactly one spinner frame should be visible after the commit
      // (no re-entrant repaint stranded a second copy of it).
      const brailleMatches = out.match(BRAILLE_FRAME_RE);
      // The spinner appears at most once in the post-commit repaint.
      // (It may not appear at all if the spinner hadn't advanced its
      // frame index yet, but it should never appear twice.)
      expect(brailleMatches?.length ?? 0).toBeLessThanOrEqual(1);
    });

    it('fires bottom-margin scrolls only for band overflow (none while the band has above-frame room)', async () => {
      // Phase 1 of the scrollback-push contract: when committing new lines
      // causes the committed band to overflow above-frame room, Phase 1
      // emits `bandOverflow` LFs at the bottom margin — each LF at the
      // bottom margin triggers a full-screen scroll under
      // `withFullScrollRegion`'s temporary `(1, rows)` DECSTBM, evicting
      // the oldest band content (real rows, never blanks) into scrollback.
      //
      // When the new band fits in the above-frame room (bandOverflow=0),
      // Phase 1 emits NO LFs — Phase 3 extends the band in-place, no
      // blank rows ever enter scrollback.
      //
      // With a 1-line idle frame, rows=24, no scrollRegion, aboveFrameRoom=22.
      // 'A' adds 1 line to an empty band → 1 line total ≪ 22 → bandOverflow=0.
      // 'A\nB\nC' adds 3 more → 4 total ≪ 22 → still bandOverflow=0.
      // LFs only fire once the cumulative band exceeds 22 lines.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();

      writes.clear();
      c.commitAbove('A');
      const out1 = writes.all();
      // Band has 1 line, room is 22 → bandOverflow=0, no LF.
      expect(out1.match(/\x1b\[24;1H\n/g)?.length ?? 0).toBe(0);
      // Phase 3 places 'A' above the frame (row 22).
      expect(out1).toMatch(/\x1b\[22;1H\x1b\[2KA/);

      writes.clear();
      c.commitAbove('A\nB\nC');
      const out3 = writes.all();
      // Band has 4 lines after merge, room is 22 → still no overflow.
      expect(out3.match(/\x1b\[24;1H\n/g)?.length ?? 0).toBe(0);
      // Phase 3 places lines above the frame at rows 19-22.
      expect(out3).toMatch(/\x1b\[20;1H\x1b\[2KA/);
      expect(out3).toMatch(/\x1b\[22;1H\x1b\[2KC/);
    });

    it('writes committed text immediately above the new live frame (gap-free above-frame placement)', async () => {
      // Phase 3 of the scrollback-push contract: after the post-clear
      // repaint() lands the new live frame at `newTopRow..rows-1`, we
      // write the committed text at rows `newTopRow - lineCount..
      // newTopRow - 1` — directly above the live frame, with no blank
      // rows between text and frame.
      //
      // This places committed content visibly in the viewport's
      // above-frame area rather than only in scrollback (which requires
      // the user to scroll up). Older commits naturally climb upward as
      // each new commit's phase-1 scrolls shift the viewport up.
      //
      // Mock stdout.rows = 24. With a 1-line live frame (just the input
      // prompt), newTopRow = 23. Committed text lands at row 22.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('ABOVE_FRAME');
      const out = writes.all();

      // The text appears positioned via a CUP escape at row `newTopRow - 1`.
      // With a 1-line idle frame (just input prompt), newTopRow = 23, so
      // the text lands at row 22.
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2KABOVE_FRAME/);

      // Phase 3 CUP write at row 22 appears in the output.
      // Phase 1 emits no LF (empty band, bandOverflow=0), so no
      // bottom-margin scroll precedes the Phase 3 write on the first commit.
      const phase3CupIdx = out.indexOf('\x1b[22;1H');
      expect(phase3CupIdx).toBeGreaterThanOrEqual(0);
    });

    it('multi-line text occupies consecutive rows immediately above the live frame', async () => {
      // 3-line text + 1-line idle frame → text at rows 20-22 (just above
      // newTopRow=23). Each line gets its own CUP positioning so they
      // start at column 1 regardless of whether the terminal driver
      // expands LF to CR+LF.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('LINE_ONE\nLINE_TWO\nLINE_THREE');
      const out = writes.all();

      // Each line CUP-positioned at its own row.
      expect(out).toMatch(/\x1b\[20;1H\x1b\[2KLINE_ONE/);
      expect(out).toMatch(/\x1b\[21;1H\x1b\[2KLINE_TWO/);
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2KLINE_THREE/);
      // Phase 1 emits no LFs on first commit (empty band, bandOverflow=0).
      // The 3 lines are placed via Phase 3 CUP writes above the frame.
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
    });

    it('text with trailing newline produces the same scroll count as text without (trailing \\n is not its own row)', async () => {
      // Regression: markdown commitBlock appends '\n' to the rendered text
      // before passing to commitAbove. That trailing newline represents
      // the end of the last paragraph row, not an additional row. If we
      // counted it as a row, we'd emit one extra scroll per commit and
      // push an extra banner-residue row to scrollback per turn.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();

      writes.clear();
      c.commitAbove('A\nB');
      const outWithout = writes.all();

      writes.clear();
      c.commitAbove('A\nB\n');
      const outWith = writes.all();

      // Both should emit the same Phase 3 CUP writes — trailing \n is
      // the line terminator, not an additional row. Phase 1 emits no LFs
      // (empty band on first commit, bandOverflow=0 either way).
      // After first commit ('A\nB'): band = ["A","B"] at rows 21..22.
      // After second commit ('A\nB\n'): same lineCount=2 → band = same positions.
      // Both Phase 3 writes land at rows 21..22.
      expect(outWithout).toMatch(/\x1b\[21;1H\x1b\[2KA/);
      expect(outWithout).toMatch(/\x1b\[22;1H\x1b\[2KB/);
      expect(outWith).toMatch(/\x1b\[21;1H\x1b\[2KA/);
      expect(outWith).toMatch(/\x1b\[22;1H\x1b\[2KB/);
    });

    it('double-newline-terminated commit preserves ALL rows with no content loss (top row archives to scrollback)', async () => {
      // Updated for the over-tall band-hold fix (commit-mode.ts): the separator-
      // inclusive bandLineCount (23) exceeds maxBandModel (22) for this exact-fit
      // scenario (rows=24, idle frame=1 row, maxBandModel=22), so useBandHold=true.
      // Phase 1 archives LINE_00 (the 1-row genuineOverflow) to scrollback via the
      // CUP-write-then-scroll mechanism. Phase 3 band-hold paints LINE_01..LINE_21 +
      // separator at viewport rows 1..22. No content is lost: LINE_00 is in
      // scrollback and LINE_01..LINE_21 are in the viewport (the end-to-end
      // no-loss invariant is pinned against a real @xterm/headless buffer by
      // terminal-compositor.band-hold-perline-gap.repro.test.ts and
      // terminal-compositor.endturn-overflow-gap.repro.test.ts).
      //
      // Pre-fix (d86f2a2 regression guard): the original test checked LINE_00 at row
      // 1 in the viewport — that assertion locked behavior the over-tall fix
      // legitimately changes. The invariant that MATTERS is "no row dropped", not
      // "every row in viewport when a 23-element band overflows maxBandModel=22".
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      // Build 22-line block. commitBlock calls commitAbove(trimmed + '\n\n');
      // we simulate that by appending '\n\n' ourselves.
      const lines = Array.from({ length: 22 }, (_, i) => `LINE_${String(i).padStart(2, '0')}`);
      c.commitAbove(lines.join('\n') + '\n\n');
      const out = writes.all();
      // The critical invariant: every content row must appear SOMEWHERE in the
      // output — either in the Phase 1 CUP-write (scrollback archive) or in
      // the Phase 3 band-hold viewport paint. No row is silently dropped.
      for (let i = 0; i < 22; i++) {
        const label = `LINE_${String(i).padStart(2, '0')}`;
        expect(out, `${label} must appear in output (not dropped)`).toContain(label);
      }
      // LINE_21 (last row) must be CUP-painted immediately above the frame (row 21
      // in the 22-row model — the model is [LINE_01..LINE_21, ''], so LINE_21 is at
      // model index 20, painted at row 21).
      expect(out).toMatch(/\x1b\[21;1H\x1b\[2KLINE_21/);
      // LINE_01 (first retained viewport row) must be at row 1 (top of viewport).
      expect(out).toMatch(/\x1b\[1;1H\x1b\[2KLINE_01/);
      // LINE_00 (archived to scrollback via Phase 1) must appear in the output
      // as a CUP-write at anchorFloor=1 before the scroll.
      expect(out).toMatch(/\x1b\[1;1H\x1b\[2KLINE_00/);
    });

    it('empty commit (compositor.commitAbove("")) places a blank row above the frame', async () => {
      // Used by the stream-renderer subagent-done path to insert a blank
      // separator line above the live frame. Phase 3 CUP-writes a blank
      // row immediately above newTopRow-1. Phase 1 emits no LF on the
      // first commit with an empty band (bandOverflow=0); the blank row
      // reaches scrollback when a subsequent commit evicts the band.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('');
      const out = writes.all();

      // Phase 3 CUP-writes a blank (empty) row at row 22 (newTopRow-1 for
      // a 1-line idle frame with rows=24).
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2K/);
      // No bottom-margin LF on first commit (empty band, bandOverflow=0).
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
    });

    it('consecutive "\\n\\n"-terminated commits paint a blank separator row between blocks (armed, with room)', async () => {
      // Regression (paragraphs-touching): commitBlock commits prose as
      // `trimmed + '\n\n'` so each block owns one trailing blank (the TUI rhythm
      // contract). d86f2a2 popped that trailing '' to fix a table exact-fit
      // cut-off, but as collateral it deleted the inter-block separator for
      // EVERY block in the armed path — consecutive paragraphs rendered with no
      // blank line between them. Fix: the separator is extracted, then re-painted
      // as a blank row whenever there is above-frame room beyond the content.
      //
      // rows=24, 1-line idle frame → newTopRow=23. After 'A\n\n': band=['A','']
      // (A@21, blank@22). After 'B\n\n': band=['A','','B',''] → A@19, blank@20,
      // B@21, blank@22. The blank at row 20 is the separator between paragraphs.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.commitAbove('A\n\n');
      writes.clear();
      c.commitAbove('B\n\n');
      const out = writes.all();
      // Block A sits two rows above block B — a blank separator occupies the row
      // between them (the buggy code butt-joined them at A@21, B@22).
      expect(out).toMatch(/\x1b\[19;1H\x1b\[2KA/);
      expect(out).toMatch(/\x1b\[21;1H\x1b\[2KB/);
      // The separator row (20) is CUP-painted blank: erase row 20 with empty
      // content, immediately followed by the CUP for row 21 (block B).
      expect(out).toContain('\x1b[20;1H\x1b[2K\x1b[21;1H');
      // Block B must NOT land immediately below A (row 20) — the butt-join.
      expect(out).not.toMatch(/\x1b\[20;1H\x1b\[2KB/);
    });

    it('single-block "\\n\\n"-terminated commit paints content + one trailing blank separator (armed, with room)', async () => {
      // The single-commit view of the same fix: `commitAbove('PARA\n\n')` paints
      // PARA immediately above a blank separator row, so the block owns its one
      // trailing blank even on the very first commit. rows=24, 1-line idle frame
      // → newTopRow=23; band=['PARA',''] → PARA@21, blank@22.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('PARA\n\n');
      const out = writes.all();
      // Content at row 21, separator blank painted at row 22 (against the frame).
      expect(out).toMatch(/\x1b\[21;1H\x1b\[2KPARA/);
      // Row 22 is CUP-erased with NO content (the blank separator), not PARA.
      expect(out).not.toMatch(/\x1b\[22;1H\x1b\[2KPARA/);
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2K(\x1b|$)/);
    });

    it('text persists in scrollback even if a subsequent grow repaint overwrites the visible above-frame copy', async () => {
      // Single-copy contract (post-dedup fix): Phase 1 emits LF scrolls only
      // (no text write) to displace the topmost viewport row into scrollback
      // and open a slot just above the live frame. Phase 3 paints the text
      // into that slot — the SOLE copy. Durability (surviving a later overlay
      // growth that repaints over the above-frame slot) is provided by
      // evict-on-growth in repaint(): when the frame grows upward and would
      // CUP-overwrite the Phase-3 slot, repaint() evicts those rows to
      // scrollback first. The text therefore persists in scrollback even when
      // the visible above-frame copy is displaced by a taller frame.
      //
      // This test verifies: (a) Phase 1 emits LFs only for band overflow
      // (bandOverflow=0 on first commit with empty band), (b) Phase 3 writes
      // the single copy immediately above the live frame (row newTopRow-1),
      // and (c) the text appears exactly once in the byte stream.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('PERSISTED');
      const out = writes.all();

      // Phase 1: no LF on first commit (empty band, bandOverflow=0). No
      // blank row enters scrollback.
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
      // Phase 3: text written above the live frame. With a 1-line idle frame,
      // newTopRow=23, so the text lands at row 22.
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2KPERSISTED/);
      // Single-copy: the text appears exactly once (Phase 3 only, no Phase 1 text).
      expect(out.match(/PERSISTED/g)?.length).toBe(1);
    });

    it('resets the committing guard if logUpdate.clear() throws', async () => {
      // Without try/finally, a throw in clear() would leave committing=true
      // and silence every future repaint() — a permanent terminal freeze.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Force logUpdate.clear() to throw on the next call. Access the
      // private logUpdate via a typed cast — this is the minimal seam
      // available without exposing internals.
      const internals = c as unknown as { logUpdate: { clear: () => void } };
      const originalClear = internals.logUpdate.clear.bind(internals.logUpdate);
      internals.logUpdate.clear = () => {
        throw new Error('clear failed');
      };
      expect(() => c.commitAbove('WILL_THROW')).toThrow('clear failed');
      // Restore clear so the subsequent repaint can run.
      internals.logUpdate.clear = originalClear;
      // Guard must have been reset — a subsequent setOverlay → repaint
      // should produce a visible frame.
      writes.clear();
      c.setOverlay('POST_THROW_OVERLAY');
      expect(writes.all()).toContain('POST_THROW_OVERLAY');
    });

    it('emits \\x1b[2K before Phase 1 CUP-positioned text write (no tail survival)', async () => {
      // Regression: H2a — when a shorter string overwrites a longer one at the
      // same CUP-positioned row, the terminal retains the tail of the previous
      // write. Pattern: "embedders can inject a custom dispatcher via" (45 chars)
      // followed by "  $ bash cd agent-afk &&… — ✓ 50 lines" (38 chars) →
      // produces "  $ bash cd …liness can inject a custom dispatcher via" on
      // screen. Fix: prefix every Phase 1 CUP write with \x1b[2K (erase entire
      // line) so only the new content survives.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();

      // First commit: long text (45 chars).
      c.commitAbove('embedders can inject a custom dispatcher via');

      // Second commit: shorter text (38 chars). Without \x1b[2K the tail of the
      // first write survives on the same row, producing garbled output.
      writes.clear();
      c.commitAbove('  $ bash cd agent-afk && — ✓ 50 lines');
      const out = writes.all();

      // Phase 1 payload must include \x1b[2K immediately after the CUP sequence
      // and before the text content — no tail of a previous longer write can
      // survive when the line is erased before the new text is placed.
      expect(out).toMatch(/\x1b\[\d+;1H\x1b\[2K.*\$ bash cd agent-afk/);
    });
  });

  describe('anchorRow protection (banner-clobber regression)', () => {
    // Regression: CupFrameRenderer.render() grows the frame upward from
    // `rows-1` via absolute CUP positioning, floored only at row 1. When
    // the live overlay is tall enough that `newTopRow` reaches into rows
    // already occupied by a pre-arm welcome banner (printed via console.log
    // before the compositor armed), the renderer's per-row
    // `cup() + ERASE_LINE + content` writes overwrite the banner in place.
    //
    // These tests pin the fix: when `anchorRow` is supplied to the
    // compositor, a repaint that would otherwise overflow the anchor evicts
    // the deficit rows to scrollback FIRST (via `\n` writes at the bottom
    // of the active DECSTBM region — each `\n` scrolls the top row of
    // the region into the terminal's scrollback buffer), and the anchor
    // is shifted up by the eviction count so subsequent repaints see the
    // adjusted ceiling.

    it('frame that fits below anchorRow renders without eviction', async () => {
      // Frame fits: 1 overlay line + gap + input = 3 lines. Bottom at row
      // 23, top at row 21. Anchor at row 15. 21 > 15 → no overflow, no
      // eviction. Assert the CUP-to-bottom + \n eviction sequence is
      // absent from the post-render byte stream.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      writes.clear();
      c.setOverlay('ONLY_ONE_LINE');
      const out = writes.all();
      // Eviction now targets the physical margin row 24 (this.stdout.rows),
      // which the frame render never writes to, so this cleanly asserts
      // no-eviction: a bare `\n` immediately after `\x1b[24;1H` (multi-newline
      // scroll trigger) must not appear.
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
      // Overlay still rendered.
      expect(out).toContain('ONLY_ONE_LINE');
    });

    it('frame that overflows anchorRow evicts the deficit to scrollback before render', async () => {
      // Force overflow: 12-line overlay forces frame to 14 lines (overlay
      // + gap + input). With rows=24 → bottomRow=23 → desiredTopRow =
      // 23 - 14 + 1 = 10. anchorRow = 15 → deficit = 5 → 5 \n writes
      // expected at the bottom of the DECSTBM region BEFORE the render's
      // CUP sequences for the frame's content.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      writes.clear();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');
      c.setOverlay(bigOverlay);
      const out = writes.all();
      // Eviction sequence: `\x1b[24;1H` followed by 5 consecutive `\n`s.
      // The implementation emits this in one stdout.write call.
      const evictionIdx = out.indexOf('\x1b[24;1H\n\n\n\n\n');
      expect(evictionIdx).toBeGreaterThanOrEqual(0);
      // First overlay line still rendered (proves the frame still ran).
      const overlayIdx = out.indexOf('OVL_0');
      expect(overlayIdx).toBeGreaterThanOrEqual(0);
      // Ordering matters: eviction MUST happen BEFORE the frame paints.
      // Without this ordering check, a buggy implementation that evicts
      // AFTER rendering (overwriting banner rows first, then scrolling
      // them into scrollback as blank-clears) would still satisfy the
      // two `toContain`-style checks above — defeating the regression's
      // purpose. The original bug was "frame overwrites banner"; the
      // fix is "evict first, then render."
      expect(evictionIdx).toBeLessThan(overlayIdx);
    });

    it('without anchorRow (undefined), no eviction even when frame is large (legacy behavior)', async () => {
      // Legacy guarantee: when anchorRow is not configured, the compositor
      // matches pre-fix behavior — frame can grow to row 1 without
      // evicting. Tests that the new path is strictly opt-in.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      });
      await c.arm();
      writes.clear();
      const bigOverlay = Array.from({ length: 18 }, (_, i) => `OVL_${i}`).join('\n');
      c.setOverlay(bigOverlay);
      const out = writes.all();
      // No multi-newline scroll sequence — eviction must not have fired.
      expect(out).not.toMatch(/\x1b\[24;1H\n\n/);
    });

    it('setAnchorRow updates the anchor dynamically at runtime', async () => {
      // Two repaints: first with anchorRow=undefined (no eviction expected
      // even though overlay is large), second after setAnchorRow(15)
      // (overflow → eviction). Pins that the setter actually rewires the
      // protection without compositor reconstruction.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      });
      await c.arm();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');

      writes.clear();
      c.setOverlay(bigOverlay);
      const phase1 = writes.all();
      expect(phase1).not.toMatch(/\x1b\[24;1H\n\n/);

      // Install the anchor — same overlay re-set to retrigger repaint.
      c.setAnchorRow(15);
      writes.clear();
      // Toggle the overlay so setOverlay does an update-and-repaint.
      c.setOverlay('');
      c.setOverlay(bigOverlay);
      const phase2 = writes.all();
      // Now eviction fires — same deficit calculation (5 rows).
      expect(phase2).toContain('\x1b[24;1H\n\n\n\n\n');
    });

    it('anchor shifts up after eviction so repeat repaints with the same frame do not double-evict', async () => {
      // After the first eviction shifts anchorRow from 15 to 10, a second
      // repaint with the same overlay sees desiredTopRow = 10 and the
      // anchor = 10 — no deficit, no second eviction. Without the shift,
      // every repaint would re-evict, scrolling the user's view away
      // until everything is in scrollback.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');

      writes.clear();
      c.setOverlay(bigOverlay);
      const phase1 = writes.all();
      expect(phase1).toContain('\x1b[24;1H\n\n\n\n\n');

      writes.clear();
      // Force another repaint by typing a character (compositor repaints
      // on every keypress that mutates the input buffer).
      stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
      const phase2 = writes.all();
      // No second eviction — anchor already shifted to match the frame top.
      expect(phase2).not.toMatch(/\x1b\[24;1H\n\n/);
    });

    it('disarm/rearm restores declared anchor — post-eviction shift does not leak across cycles', async () => {
      // Regression (H1, PR #539 review): repaint() mutates the working
      // anchorRow during eviction (15 → 10), but resetState() did not
      // clear it. On the next arm() the field still held 10, so the
      // declared ceiling was silently under-protected by 5 rows. The fix
      // separates the declared snapshot (constructor / setAnchorRow value)
      // from the working ceiling (mutated by eviction). On disarm the
      // working ceiling clears; on rearm it re-seeds from the declared
      // snapshot. This test:
      //   1. Arms with anchorRow=15, evicts (shifts working to 10).
      //   2. Disarms.
      //   3. Rearms — working anchor must be 15 again, NOT 10.
      //   4. Verifies behaviorally by repainting the same large overlay:
      //      a second eviction MUST fire (deficit = 15 - 10 = 5 rows).
      //      With the bug, working anchor stays at 10 → no overflow →
      //      no eviction — this would fail.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');

      writes.clear();
      c.setOverlay(bigOverlay);
      expect(writes.all()).toContain('\x1b[24;1H\n\n\n\n\n');

      c.disarm();
      await c.arm();

      writes.clear();
      // Toggle to retrigger a repaint of the same large overlay. If the
      // working anchor leaked across cycles at value 10, this would not
      // overflow and would not evict. With the fix, the working anchor
      // is back at 15 → overflow → 5-row eviction fires again.
      c.setOverlay('');
      c.setOverlay(bigOverlay);
      expect(writes.all()).toContain('\x1b[24;1H\n\n\n\n\n');

      c.disarm();
    });

    it('setAnchorRow updates the declared snapshot — survives disarm/rearm', async () => {
      // Companion to the prior test: setAnchorRow() must also persist
      // across disarm/rearm. Construction starts with anchorRow=15;
      // setAnchorRow(undefined) clears it; after disarm/rearm the working
      // anchor must reflect the SETTER value (undefined → no protection),
      // not the CONSTRUCTOR value (15 → eviction).
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      c.setAnchorRow(undefined);
      c.disarm();
      await c.arm();

      writes.clear();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');
      c.setOverlay(bigOverlay);
      // Setter cleared protection → no eviction even with overflow-sized
      // overlay. If the ctor value had been incorrectly restored on rearm,
      // a 5-row eviction would fire here.
      expect(writes.all()).not.toMatch(/\x1b\[24;1H\n\n/);

      c.disarm();
    });

    it('commitAbove does NOT write text into banner rows even with anchorRow set (single-copy dedup fix)', async () => {
      // Post-dedup fix: Phase 1 is scroll-only (no text write at all),
      // which eliminates the "padded echo appearing above the banner"
      // artifact entirely — Phase 1 never writes to the banner zone.
      // Phase 3 writes the single copy above the live frame, respecting
      // anchorRow as a textStartRow floor so it never lands in pre-arm
      // banner rows either.
      //
      // With anchorRow=10, a 1-line commit, and rows=24 (idle 1-line frame):
      //   fitsAboveFrame = true, empty band, 13 rows of above-frame room →
      //     bandOverflow = max(0, 0 + 1 - 13) = 0 → Phase 1 emits NO scroll
      //   Phase 2 repaint → topRow=23
      //   Phase 3 textStartRow = max(10, 23-1) = 22 → text at row 22
      //
      // The committed line appears at row 22 (inside the frame zone, NOT the
      // banner zone rows 1..9) and is NOT written into the banner.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 10,
      });
      await c.arm();
      writes.clear();
      // Simulate the right-aligned echo InputSurface would produce.
      const paddedEcho = ' '.repeat(60) + '/review 539';
      c.commitAbove(paddedEcho);
      const out = writes.all();

      // Phase 1 does NOT write text at anchorRow (10) or row 1 — scroll-only.
      // Negative: neither the banner-clobber row nor the legacy row 1 carries text.
      expect(out).not.toContain(`\x1b[10;1H\x1b[2K${paddedEcho}`);
      expect(out).not.toContain(`\x1b[1;1H${paddedEcho}`);
      // Phase 3 writes the single copy above the live frame (row 22).
      expect(out).toContain(`\x1b[22;1H\x1b[2K${paddedEcho}`);
      // The FIRST commit into an empty band with ample above-frame room is
      // scroll-free (bandOverflow=0) — identical to the no-anchor single-copy
      // path. The banner no longer forces a spurious lineCount scroll on every
      // commit; that quirk left the floor stale and orphaned committed content
      // in the vacated banner rows — see terminal-compositor.banner-commit-gap.test.ts.
      // The single copy enters scrollback later via evict-on-growth / the next commit.
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
    });

    it('commitAbove Phase 3 always lands at row newTopRow-1 regardless of anchorRow (single-copy path)', async () => {
      // Backward-compat pin: with no anchorRow set, Phase 1 is still
      // scroll-only (the dedup fix applies uniformly). Phase 3 writes the
      // single copy at row newTopRow-1 (22 with a 1-line idle frame and
      // rows=24). Text does NOT appear at row 1 in the byte stream.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      });
      await c.arm();
      writes.clear();
      c.commitAbove('LEGACY_NO_ANCHOR');
      const out = writes.all();
      // Phase 3 writes at row 22 (newTopRow-1 for a 1-line idle frame).
      expect(out).toContain('\x1b[22;1H\x1b[2KLEGACY_NO_ANCHOR');
      // Phase 1 is scroll-only — text must NOT appear at row 1.
      expect(out).not.toContain('\x1b[1;1H\x1b[2KLEGACY_NO_ANCHOR');
      // No LF on first commit (no anchorRow → canUseMergePath=true, empty band
      // → bandOverflow=0). The content enters scrollback via evict-on-growth.
    });

    it('commitAbove Phase 3 textStartRow floors at anchorRow (no banner-row CUP write)', async () => {
      // Phase 3 writes the committed text into the visible above-frame
      // area at row `max(1, newTopRow - lineCount)` for visible
      // accumulation. With a 3-line commit, idle 1-line frame
      // (newTopRow=23), and anchorRow=22, the pre-fix textStartRow =
      // max(1, 20) = 20, which is INSIDE the pre-arm banner zone (rows
      // 1..21). The fix floors at anchorRow=22.
      //
      // Post-fix (over-tall band-hold): maxBandModel = overflowTargetBottom -
      // anchorFloor = 23 - 22 = 1. The 3-line block exceeds maxBandModel, so
      // useBandHold=true. Phase 1 archives the genuineOverflow (rows L1, L2) to
      // scrollback via CUP-write at anchorFloor=22 + scroll. Phase 3 band-hold
      // paints the capped model (last 1 row = [L3]) at row 22 (targetBottom).
      // The core invariant — no banner-row (rows 1..21) CUP write — is preserved.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 22,
      });
      await c.arm();
      writes.clear();
      c.commitAbove('L1\nL2\nL3');
      const out = writes.all();

      // Phase 3 must NOT write at rows 20-21 (banner zone).
      expect(out).not.toMatch(/\x1b\[20;1H\x1b\[2KL1/);
      expect(out).not.toMatch(/\x1b\[21;1H\x1b\[2KL2/);
      // All three lines must appear somewhere in the output (no content loss).
      // L1 and L2 are archived to scrollback via band-hold Phase 1 (CUP at row 22);
      // L3 is painted in the viewport via Phase 3 band-hold (model=[L3] at row 22).
      expect(out).toContain('L1');
      expect(out).toContain('L2');
      expect(out).toContain('L3');
      // Band-hold Phase 1 writes at anchorFloor (row 22) then scrolls:
      // the oldest genuineOverflow rows (L1, L2) are archived to scrollback.
      // The old legacy-overflow assertion '\x1b[24;1H\n\n\n' (3 newlines) no
      // longer applies — band-hold archives 2 rows (2 newlines), not 3.
      expect(out).toContain('\x1b[24;1H\n\n');
      expect(out).not.toContain('\x1b[24;1H\n\n\n');
    });
  });

});
