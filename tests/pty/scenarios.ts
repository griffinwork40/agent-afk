/**
 * PTY scrollback harness — scenario definitions (issue #541).
 *
 * Each scenario drives the REAL `TerminalCompositor` through one of the
 * gap-class geometries that the byte-level `@xterm/headless` unit tests
 * (src/cli/terminal-compositor.*.test.ts) cover in-process. Here the SAME
 * geometries run inside a real OS pseudo-terminal (node-pty): the compositor
 * sees a genuine TTY, real winsize, and real async flush through the kernel
 * pty, and its output is reconstructed by an xterm emulator so assertions can
 * read the emulator's SCROLLBACK buffer — the property docs/scrollback.md:9-13
 * says mock-stdout tests cannot certify. See tests/pty/harness.ts for the
 * spawn/capture machinery and tests/pty/driver.ts for the in-pty entry point.
 *
 * A scenario's `drive()` runs INSIDE the pty child (via tsx). Its `expect`
 * block is evaluated by the vitest parent against the parsed emulator buffer.
 * `drive()` deliberately does NOT `disarm()` — the parent snapshots the final
 * LIVE frame state (content above a bottom-pinned frame), which is the exact
 * geometry the regressions are about.
 */

import { TerminalCompositor } from '../../src/cli/terminal-compositor.js';
import { StatusLine } from '../../src/cli/status-line.js';
import { LoopStageBar } from '../../src/cli/commands/interactive/loop-stage.js';
import { renderMarkdownToTerminal } from '../../src/cli/formatter.js';
import { formatSubmittedEcho } from '../../src/cli/input/echo.js';
import { commitBlockAbove } from '../../src/cli/_lib/commit-block.js';
import { buildResizeMarker } from './constants.js';

/** Runtime handed to a scenario's drive() from inside the pty child. */
export interface PtyDriveCtx {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}

/**
 * Expectations checked by the parent against the reconstructed emulator buffer.
 * Every field is optional; a scenario uses the subset relevant to its geometry.
 */
export interface PtyExpect {
  /** Substrings that MUST appear in the emulator scrollback (above baseY). */
  inScrollback?: string[];
  /** Substrings that MUST appear in the viewport, above the live frame. */
  inViewport?: string[];
  /** Substrings that MUST appear exactly once across the WHOLE buffer. */
  exactlyOnce?: string[];
  /** Substrings that MUST NOT appear anywhere in the buffer. */
  absent?: string[];
  /**
   * Max run of consecutive blank rows between the first content row and the
   * live frame in the viewport. One blank is the legit rhythm separator; a
   * larger run is the "void" regression. Default (undefined) = not checked.
   */
  maxViewportBlankRun?: number;
  /**
   * Content-only anchors marking the LAST committed content row, used solely
   * to bound the maxViewportBlankRun window. Declare this when a scenario's
   * `exactlyOnce`/`inViewport` sets carry live-frame CHROME strings (e.g. a
   * StatusLine model id): the blank-run window must end at the last committed
   * CONTENT row, never at a chrome row below it, or the void scan spills into
   * the frame and over-counts on correct output. When unset, the window falls
   * back to `inViewport ∪ exactlyOnce` (correct only when those hold no chrome).
   */
  contentAnchors?: string[];
  /**
   * Substring pairs [a, b] where the first row containing `a` must appear
   * strictly above the first row containing `b` across the whole buffer.
   */
  order?: [string, string][];
  /**
   * Soft-wrap rejoinability of ONE logical line (issue #540 axis-2). The parent
   * takes the buffer span from the first row containing `from` to the first row
   * at/after it containing `to`, and counts rows that are NOT soft-wrap
   * continuations (emulator isWrapped=false). A logical line the terminal
   * reflowed cleanly has exactly ONE such row (its head) → `tmux -J` rejoins it;
   * an app-hard-wrapped line flushed to scrollback shows interior non-wrapped
   * rows. `maxNonWrappedRows` asserts the rejoined property (1 = clean);
   * `minNonWrappedRows` asserts the fragmented property (2+ = the axis-2 bug).
   * `minSpanRows` asserts the span occupies >= N rows — used to PROVE a resize
   * actually took effect (e.g. a line that is 1 row wide but must become 2 rows
   * once the pane narrows), so a silently no-op'd resize handshake fails loudly.
   */
  logicalSpan?: { from: string; to: string; maxNonWrappedRows?: number; minNonWrappedRows?: number; minSpanRows?: number };
}

export interface PtyScenario {
  /** One-line description surfaced in the test name and failure dumps. */
  description: string;
  /** pty + emulator geometry. */
  cols: number;
  rows: number;
  /** Reference to the in-process regression this mirrors (for humans). */
  ref: string;
  drive(ctx: PtyDriveCtx): Promise<void> | void;
  expect: PtyExpect;
}

/** Let the frame's async spinner/flush settle before the next step. */
const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Request a mid-scenario width resize from INSIDE the pty child. Emits the
 * resize-handshake marker (which the parent watches for → calls node-pty
 * child.resize → SIGWINCH), then waits for this process's OWN 'resize' event
 * (how the driver learns the new winsize landed) before returning, so the
 * caller can repaint at the new geometry. A 2s timeout guards against a parent
 * that never resizes (e.g. a non-resize run) so drive() can never hang.
 */
async function requestResize(ctx: PtyDriveCtx, cols: number, rows: number): Promise<void> {
  const { stdout } = ctx;
  const landed = new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdout.removeListener('resize', finish);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    stdout.once('resize', finish);
  });
  stdout.write(buildResizeMarker(cols, rows));
  await landed;
  // Give the compositor's own SIGWINCH handler a beat to re-render at the new
  // width before the caller repaints / the driver emits the DONE sentinel.
  await settle(60);
}

/** Cast to reach the compositor's internal repaint() (as the unit tests do). */
type Repaintable = { repaint(): void };

/** Production footer wiring: StatusLine + LoopStageBar + after-scroll restore. */
function wireProductionFooter(stdout: NodeJS.WriteStream, model: string): StatusLine {
  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model, cost: 0, tokens: 0, contextPct: 0 });
  const loopStageBar = new LoopStageBar({ getExtraRows: () => statusLine.getExtraRows(), stream: stdout });
  loopStageBar.setRowCountChangeHandler(() => statusLine.setExtraRows(1));
  statusLine.setAfterScrollRestore(() => loopStageBar.redraw());
  loopStageBar.start();
  return statusLine;
}

/** Minimal StatusLine-only scroll region (collapse-void / overflow-gap style). */
function wireStatusLine(stdout: NodeJS.WriteStream, model: string): StatusLine {
  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model, cost: 0, tokens: 0, contextPct: 0 });
  return statusLine;
}

const TABLE_MD = [
  '| # | Change | File | Nature |',
  '|---|--------|------|--------|',
  '| 1 | pass cwd to scheduler | scheduler.ts | behavior |',
  '| 2 | load config from cwd | config-loader.ts | behavior |',
  '| 3 | thread cwd through daemon | daemon.ts | plumbing |',
].join('\n');

export const SCENARIOS: Record<string, PtyScenario> = {
  // ─────────────────────────────────────────────────────────────────────────
  // multi-commit: many commitAbove calls under a held tall overlay overflow the
  // screen — the OLDEST lines must land in the emulator SCROLLBACK, each row
  // exactly once (no duplication, no loss), with no void above the frame. This
  // is the scenario that proves "committed lines reach scrollback", not just
  // "bytes were written". Mirrors terminal-compositor.multi-commit-gap.test.ts.
  // ─────────────────────────────────────────────────────────────────────────
  'multi-commit-gap': {
    description: 'many commits under a held overlay overflow into scrollback with no loss/dup/void',
    cols: 80,
    rows: 24,
    ref: 'terminal-compositor.multi-commit-gap.test.ts',
    async drive({ stdout, stdin }): Promise<void> {
      const statusLine = wireProductionFooter(stdout, 'STATUSMODELXYZ');
      const c = new TerminalCompositor({ stdout, stdin, onCancel: () => {}, scrollRegion: statusLine, anchorRow: 1 });
      await c.arm();
      const ix = c as unknown as Repaintable;
      c.setSpinner({ enabled: true });
      // 18 single-line tool outputs, each under a persistent 10-line overlay
      // (the tall-frame trigger) — enough content to overflow rows=24.
      for (let k = 0; k < 18; k++) {
        c.setOverlay(Array.from({ length: 10 }, (_, i) => `stream ${k}.${i}`).join('\n'));
        c.commitAbove(`TOOL_OUTPUT_${String(k).padStart(2, '0')}\n`);
      }
      c.commitAbove('memory_search — done\nbash x37 — done\nDone (114 tools)\n');
      c.setOverlay('');
      ix.repaint();
      ix.repaint();
      await settle();
    },
    expect: {
      // Oldest committed lines overflowed above the viewport → scrollback.
      inScrollback: ['TOOL_OUTPUT_00', 'TOOL_OUTPUT_01'],
      // The rollup tail re-pins adjacent to the collapsed frame.
      inViewport: ['Done (114 tools)'],
      // Every committed row present exactly once across scrollback + viewport.
      exactlyOnce: [
        'TOOL_OUTPUT_00', 'TOOL_OUTPUT_05', 'TOOL_OUTPUT_11', 'TOOL_OUTPUT_17',
        'Done (114 tools)', 'STATUSMODELXYZ',
      ],
      // 'STATUSMODELXYZ' above is the StatusLine model id (live-frame chrome).
      // Bound the void scan by committed CONTENT only, so lastAnchor lands on
      // the rollup tail — not the chrome status row below the frame.
      contentAnchors: ['TOOL_OUTPUT_17', 'Done (114 tools)'],
      maxViewportBlankRun: 1,
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // collapse-void (#539): a tall overlay held across a streamed report, then
  // the overlay collapses at end-of-turn. The whole report must re-pin as ONE
  // contiguous block hugging the frame — no multi-row void, no lost HEADER, no
  // duplicated rows. Mirrors terminal-compositor.collapse-void.test.ts.
  // ─────────────────────────────────────────────────────────────────────────
  'collapse-void': {
    description: 'tall overlay collapse re-pins the report contiguously (no void, no lost header)',
    cols: 100,
    rows: 40,
    ref: '#539 · terminal-compositor.collapse-void.test.ts',
    async drive({ stdout, stdin }): Promise<void> {
      const statusLine = wireStatusLine(stdout, 'M');
      const c = new TerminalCompositor({ stdout, stdin, onCancel: () => {}, scrollRegion: statusLine, anchorRow: 1 });
      await c.arm();
      statusLine.setExtraRows(1);
      c.setSpinner({ enabled: true });
      const overlay = Array.from({ length: 22 }, (_, i) => `thinking ${i} keeping the frame tall`).join('\n');
      const commit = (s: string): void => { c.setOverlay(overlay); c.commitAbove(s); };
      commit('HEADER-MARKER Diagnosis summary\n\n');
      for (let i = 1; i <= 6; i++) commit(`PROSE-${String(i).padStart(2, '0')} report line\n\n`);
      const table = renderMarkdownToTerminal(TABLE_MD, { maxWidth: 100 - 2 }).replace(/\n+$/, '');
      commit(`${table}\nBODY-TAIL-ROW final line of report\n\n`);
      c.setSpinner({ enabled: false });
      c.setOverlay('');
      const ix = c as unknown as Repaintable;
      ix.repaint();
      ix.repaint();
      await settle();
    },
    expect: {
      inViewport: ['HEADER-MARKER', 'PROSE-01', 'PROSE-06', 'BODY-TAIL-ROW', 'pass cwd to scheduler'],
      exactlyOnce: [
        'HEADER-MARKER', 'PROSE-01', 'PROSE-03', 'PROSE-06',
        'BODY-TAIL-ROW', 'pass cwd to scheduler', 'thread cwd through daemon',
        'Nature', // table header cell — guards the duplicate-header regression
      ],
      maxViewportBlankRun: 1,
      order: [['HEADER-MARKER', 'PROSE-01'], ['PROSE-06', 'BODY-TAIL-ROW']],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // overflow-gap: a multi-line markdown table committed under a tall overlay
  // (extraRows=2 production footer geometry), then collapse. The table header
  // must appear EXACTLY ONCE (pre-fix: one scrollback copy + one truncated
  // on-screen copy) with the body intact and no void. Mirrors
  // terminal-compositor.overflow-gap.test.ts.
  // ─────────────────────────────────────────────────────────────────────────
  'overflow-gap': {
    description: 'table committed under a tall overlay collapses with no duplicate header and no void',
    cols: 120,
    rows: 24,
    ref: 'terminal-compositor.overflow-gap.test.ts',
    async drive({ stdout, stdin }): Promise<void> {
      const statusLine = wireStatusLine(stdout, 'M');
      const c = new TerminalCompositor({ stdout, stdin, onCancel: () => {}, scrollRegion: statusLine, anchorRow: 1 });
      await c.arm();
      statusLine.setExtraRows(2); // StatusLine + LoopStageBar + VerdictLedger
      c.setSpinner({ enabled: true });
      const tableText = renderMarkdownToTerminal(TABLE_MD, { width: 120 }).replace(/\n$/, '');
      const tallOverlay = Array.from({ length: 14 }, (_, i) => `thinking ${i} — dispatched subagent, verifying claim ${i}`).join('\n');
      c.setOverlay(tallOverlay); c.commitAbove('Diagnosis complete\n\n');
      c.setOverlay(tallOverlay); c.commitAbove('What I diagnosed: the TUI rendering defect in your screenshot.\n\n');
      c.setOverlay(tallOverlay); c.commitAbove(tableText + '\n\n');
      c.setOverlay(tallOverlay); c.commitAbove('Evidence (deterministic, reproduced): header + divider render, then a gap.\n\n');
      c.setOverlay('');
      const ix = c as unknown as Repaintable;
      ix.repaint();
      ix.repaint();
      await settle();
    },
    expect: {
      inViewport: ['pass cwd to scheduler', 'load config from cwd', 'thread cwd through daemon', 'Diagnosis complete'],
      // "Nature" is the table header cell — appears once iff the header is not
      // duplicated (the exact pre-fix symptom: one scrollback + one on-screen copy).
      exactlyOnce: ['pass cwd to scheduler', 'load config from cwd', 'thread cwd through daemon', 'Diagnosis complete', 'Nature'],
      maxViewportBlankRun: 1,
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // shrink-gap: a committed line above a tall overlay; then the overlay
  // collapses while a spinner appears (a shrink). The committed line must
  // re-pin adjacent to the frame — not stranded with a blank void below it.
  // Mirrors terminal-compositor.shrink-gap.test.ts.
  // ─────────────────────────────────────────────────────────────────────────
  'shrink-gap': {
    description: 'committed line re-pins adjacent to the frame after the overlay shrinks (no gap)',
    cols: 80,
    rows: 24,
    ref: 'terminal-compositor.shrink-gap.test.ts',
    async drive({ stdout, stdin }): Promise<void> {
      // shrink-gap.test.ts uses a minimal scroll region, not a StatusLine.
      const scrollRegion = {
        withFullScrollRegion<T>(fn: () => T): T {
          stdout.write('\x1b[s');
          stdout.write('\x1b[r');
          stdout.write('\x1b[u');
          try {
            return fn();
          } finally {
            const rows = stdout.rows ?? 24;
            stdout.write('\x1b[s');
            stdout.write(`\x1b[1;${rows}r`);
            stdout.write('\x1b[u');
          }
        },
        getExtraRows(): number { return 0; },
      };
      const c = new TerminalCompositor({ stdout, stdin, onCancel: () => {}, scrollRegion, anchorRow: 1 });
      await c.arm();
      const tall = Array.from({ length: 12 }, (_, i) => `stream line ${i}`).join('\n');
      c.setOverlay(tall);
      c.commitAbove('COMMITTED_TOOL_OUTPUT_LINE\n');
      c.setSpinner({ enabled: true });
      c.setOverlay('');
      const ix = c as unknown as Repaintable;
      ix.repaint();
      ix.repaint();
      await settle();
    },
    expect: {
      inViewport: ['COMMITTED_TOOL_OUTPUT_LINE'],
      exactlyOnce: ['COMMITTED_TOOL_OUTPUT_LINE'],
      maxViewportBlankRun: 1,
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // first-turn-image-echo (#509): the FIRST commit after arm, following a
  // pre-arm banner and a pre-submit chrome cycle, for a message carrying an
  // IMAGE ATTACHMENT. Faithful to production (input-surface.ts:492): the echo —
  // a multi-line user card PLUS the dim `[image attached]` summary row — is
  // committed as ONE block via commitBlockAbove, NOT per-line (per-line forces N
  // independent geometry decisions and is the void-prone path; see
  // src/cli/_lib/commit-block.ts:13-24). The card body, the `[image attached]`
  // summary, and the response must each land EXACTLY ONCE and in order (no
  // orphan/duplicate copies — the reported double-render), and every banner row
  // must reach real scrollback intact. Real-TTY sibling of the headless
  // single-block guard in terminal-compositor.first-turn-echo-image.test.ts;
  // the whole-buffer xterm replay still can't reproduce the terminal-only DECAWM
  // deferred-wrap artifact, but it certifies the single-copy committed-band
  // property over a real pty, which the mock-stdout path cannot.
  // ─────────────────────────────────────────────────────────────────────────
  'first-turn-image-echo': {
    description: 'first commit after banner echoes the image card + [image attached] once, block-committed',
    cols: 80,
    rows: 24,
    ref: '#509 · terminal-compositor.first-turn-echo-image.test.ts',
    async drive({ stdout, stdin }): Promise<void> {
      const BANNER_ROWS = 11;
      const MESSAGE = 'Reply with only the word ok and nothing else. DUPCHECK alpha bravo charlie delta echo foxtrot golf hotel india';
      for (let i = 0; i < BANNER_ROWS; i++) stdout.write(`BANNER_LINE_${i}\n`);
      const statusLine = wireProductionFooter(stdout, 'M');
      const c = new TerminalCompositor({ stdout, stdin, onCancel: () => {}, scrollRegion: statusLine, anchorRow: BANNER_ROWS + 1 });
      await c.arm();
      const ix = c as unknown as Repaintable;
      // Pre-submit chrome cycle: transient chrome then collapse back to idle.
      c.setOverlay('preflight-line');
      c.setOverlay('');
      // Image-attachment echo shape: multi-line card + dim `[image attached]`
      // trailer, committed as ONE block via commitBlockAbove — the exact
      // production path (input-surface.ts:492), NOT the per-line loop.
      const echo = formatSubmittedEcho({
        buffer: MESSAGE,
        promptText: 'afk (haiku)  › ',
        isTTY: true,
        terminalWidth: 80,
        attachmentSummary: '[image attached]',
      });
      commitBlockAbove(c, echo.split('\n'));
      c.commitAbove('');
      c.setSpinner({ enabled: true });
      for (let g = 2; g <= 14; g += 3) {
        c.setOverlay(Array.from({ length: g }, (_, i) => `stream-row ${g}.${i}`).join('\n'));
      }
      c.commitAbove('RESPONSE_OK');
      c.setSpinner({ enabled: false });
      c.setOverlay('');
      ix.repaint();
      ix.repaint();
      await settle();
    },
    expect: {
      // Banner rows written before arm overflow past baseY (observed baseY=13)
      // into real scrollback — the property this scenario is named for. Assert
      // the REGION (not just whole-buffer presence via exactlyOnce/order), so a
      // regression that left the banner in the viewport would fail here.
      inScrollback: ['BANNER_LINE_0', 'BANNER_LINE_10'],
      exactlyOnce: [
        'DUPCHECK', 'india', '[image attached]', 'RESPONSE_OK',
        'BANNER_LINE_0', 'BANNER_LINE_5', 'BANNER_LINE_10',
      ],
      order: [
        ['BANNER_LINE_10', 'DUPCHECK'],
        ['DUPCHECK', 'india'],
        ['india', '[image attached]'],
        ['[image attached]', 'RESPONSE_OK'],
      ],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // width-resize-reflow-sanity: HARNESS SELF-CHECK for the resize handshake
  // (#541 extension). A SHORT committed line (fits at both widths → always one
  // row) scrolls into scrollback, then the pane WIDENS mid-scenario. It must
  // survive the resize as exactly one rejoinable row. This is GREEN before AND
  // after the axis-2 fix — it certifies the resize marker → child.resize →
  // emulator.resize replay path moves content faithfully, so a broken handshake
  // fails HERE (loudly) rather than silently masking the RED guards below.
  // ─────────────────────────────────────────────────────────────────────────
  'width-resize-reflow-sanity': {
    description: 'harness resize handshake: a scrolled-off line that fits wide re-wraps to 2 rows when narrowed',
    cols: 80,
    rows: 24,
    ref: '#541 resize-handshake self-check',
    async drive(ctx): Promise<void> {
      const { stdout, stdin } = ctx;
      const statusLine = wireProductionFooter(stdout, 'M');
      const c = new TerminalCompositor({ stdout, stdin, onCancel: () => {}, scrollRegion: statusLine, anchorRow: 1 });
      await c.arm();
      const ix = c as unknown as Repaintable;
      c.setSpinner({ enabled: true });
      const overlay = Array.from({ length: 12 }, (_, i) => `thinking ${i}`).join('\n');
      // ~62 cols: ONE row at 80 (fits, so afk stores it un-hard-wrapped — this
      // property is stable across PR 2), but must soft-wrap to 2 rows at 40.
      c.setOverlay(overlay); c.commitAbove(`SANITYSTART_${'y'.repeat(40)}_SANITYEND\n`);
      for (let k = 0; k < 24; k++) { c.setOverlay(overlay); c.commitAbove(`PAD_${String(k).padStart(2, '0')}\n`); }
      c.setOverlay(''); ix.repaint(); ix.repaint();
      await settle();
      await requestResize(ctx, 40, 24); // NARROW 80 → 40
      ix.repaint(); ix.repaint();
      await settle();
    },
    expect: {
      inScrollback: ['SANITYSTART'], // precondition: the line scrolled off screen
      // maxNonWrappedRows:1 = the terminal cleanly soft-wrapped it (rejoinable);
      // minSpanRows:2 = it actually re-wrapped, PROVING child.resize fired (a
      // no-op'd resize would leave it 1 row at width 80 and fail here).
      logicalSpan: { from: 'SANITYSTART', to: 'SANITYEND', maxNonWrappedRows: 1, minSpanRows: 2 },
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // width-resize-fragment-narrow (#540 axis-2 · RED GUARD): a long LOGICAL line
  // committed WIDE (100 cols) is hard-wrapped to physical rows at commit time
  // (terminal-compositor.committed-band-commit.ts:165) and flushed to native
  // scrollback as hard-newline rows. On a NARROWER resize the terminal reflows
  // each hard row independently, so the one logical line shows ≥2 non-wrapped
  // (isWrapped=false) rows in its span — it is NOT `tmux -J`-rejoinable. This is
  // the user's screenshot. It is GREEN NOW (documents the bug); when PR 2 (#540
  // Stage 3 logical flush) makes the flush emit logical lines, the count drops
  // to 1 and THIS ASSERTION WILL FAIL — the signal to flip minNonWrappedRows →
  // maxNonWrappedRows: 1 and retire this as the GREEN regression guard.
  // ─────────────────────────────────────────────────────────────────────────
  'width-resize-fragment-narrow': {
    description: 'wide-committed logical line in scrollback fragments on a NARROWER resize (RED guard, #540 axis-2)',
    cols: 120,
    rows: 24,
    ref: '#540 axis-2 · terminal-compositor.committed-band-commit.ts:165',
    async drive(ctx): Promise<void> {
      const { stdout, stdin } = ctx;
      const statusLine = wireProductionFooter(stdout, 'M');
      const c = new TerminalCompositor({ stdout, stdin, onCancel: () => {}, scrollRegion: statusLine, anchorRow: 1 });
      await c.arm();
      const ix = c as unknown as Repaintable;
      c.setSpinner({ enabled: true });
      const overlay = Array.from({ length: 12 }, (_, i) => `thinking ${i} keeping the frame tall`).join('\n');
      // One long logical line (186 cols, no interior break points) → hard-wraps
      // to 2 physical rows at 120 cols ([120,66]); committed first so it
      // overflows to scrollback under the tall overlay. Target width 68 is NOT a
      // divisor of 120, so the char-100 hard break lands mid-wrap → a visibly
      // ragged short row, exactly the user's screenshot.
      const longLine = `LOGSTART_${'x'.repeat(170)}_LOGEND`;
      c.setOverlay(overlay); c.commitAbove(longLine + '\n');
      for (let k = 0; k < 24; k++) { c.setOverlay(overlay); c.commitAbove(`FILLER_${String(k).padStart(2, '0')}\n`); }
      c.setOverlay(''); ix.repaint(); ix.repaint();
      await settle();
      await requestResize(ctx, 68, 24); // NARROW 120 → 68 (non-divisor → ragged)
      ix.repaint(); ix.repaint();
      await settle();
    },
    expect: {
      inScrollback: ['LOGSTART'], // precondition: the long line scrolled off screen
      // minSpanRows:3 PROVES the narrow fired (the line is 2 rows at 120, 3 at
      // 68) and is stable across PR 2; minNonWrappedRows:2 is the RED flip signal.
      logicalSpan: { from: 'LOGSTART', to: 'LOGEND', minNonWrappedRows: 2, minSpanRows: 3 },
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // width-resize-fragment-widen (#540 axis-2 · RED GUARD): the widen twin. A
  // long logical line committed NARROW (50 cols) hard-wraps to several physical
  // rows and flushes to scrollback. On a WIDER resize the terminal cannot rejoin
  // app hard-newlines, so the rows stay ragged/short — ≥2 non-wrapped rows in
  // the span (each afk row is ≤50 ≤100 so none even soft-wraps). GREEN NOW; flips
  // to FAIL when PR 2 emits one logical line (which the widen reflows to fewer
  // rows with a single non-wrapped head). See the narrow twin's note.
  // ─────────────────────────────────────────────────────────────────────────
  'width-resize-fragment-widen': {
    description: 'narrow-committed logical line in scrollback stays ragged on a WIDER resize (RED guard, #540 axis-2)',
    cols: 48,
    rows: 24,
    ref: '#540 axis-2 · terminal-compositor.committed-band-commit.ts:165',
    async drive(ctx): Promise<void> {
      const { stdout, stdin } = ctx;
      const statusLine = wireProductionFooter(stdout, 'M');
      const c = new TerminalCompositor({ stdout, stdin, onCancel: () => {}, scrollRegion: statusLine, anchorRow: 1 });
      await c.arm();
      const ix = c as unknown as Repaintable;
      c.setSpinner({ enabled: true });
      const overlay = Array.from({ length: 12 }, (_, i) => `thinking ${i} tall`).join('\n');
      // 186 cols → hard-wraps to 4 physical rows at 48 cols. On a WIDEN to 110
      // those 4 rows stay separate (each <=48 fits at 110, so the terminal never
      // rejoins the app hard-newlines) → 4 ragged non-wrapped rows.
      const longLine = `LOGSTART_${'x'.repeat(170)}_LOGEND`;
      c.setOverlay(overlay); c.commitAbove(longLine + '\n');
      for (let k = 0; k < 24; k++) { c.setOverlay(overlay); c.commitAbove(`FILLER_${String(k).padStart(2, '0')}\n`); }
      c.setOverlay(''); ix.repaint(); ix.repaint();
      await settle();
      await requestResize(ctx, 110, 24); // WIDEN 48 → 110
      ix.repaint(); ix.repaint();
      await settle();
    },
    expect: {
      inScrollback: ['LOGSTART'],
      // minNonWrappedRows:2 is the RED flip signal (4 ragged rows now → 1 after
      // PR 2 rejoins the logical line). The resize MECHANISM is certified by the
      // sanity scenario; a widen cannot prove itself via row count (it is
      // unchanged pre-fix), so no minSpanRows here.
      logicalSpan: { from: 'LOGSTART', to: 'LOGEND', minNonWrappedRows: 2 },
    },
  },
};

export type ScenarioName = keyof typeof SCENARIOS;
