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
  // first-turn-image-echo (#509): the FIRST commitAbove after arm, following a
  // pre-arm banner and a pre-submit chrome cycle. The echoed submit card must
  // commit exactly once (no orphan/duplicate copies), its body must survive
  // streaming growth, and every banner row must remain intact. Mirrors
  // terminal-compositor.first-turn-banner-echo.test.ts.
  // ─────────────────────────────────────────────────────────────────────────
  'first-turn-image-echo': {
    description: 'first commit after banner echoes the submit card once and preserves banner + body',
    cols: 80,
    rows: 24,
    ref: '#509 · terminal-compositor.first-turn-banner-echo.test.ts',
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
      const echo = formatSubmittedEcho({ buffer: MESSAGE, promptText: 'afk (haiku)  › ', isTTY: true, terminalWidth: 80 });
      for (const line of echo.split('\n')) c.commitAbove(line);
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
        'DUPCHECK', 'india', 'RESPONSE_OK',
        'BANNER_LINE_0', 'BANNER_LINE_5', 'BANNER_LINE_10',
      ],
      order: [['BANNER_LINE_10', 'DUPCHECK'], ['DUPCHECK', 'india'], ['india', 'RESPONSE_OK']],
    },
  },
};

export type ScenarioName = keyof typeof SCENARIOS;
