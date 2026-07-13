/**
 * Regression coverage for the FIRST-TURN user-message echo when the message
 * carries an image attachment (`[image attached]` summary row).
 *
 * ## Why this file exists (investigation, 2026-07)
 * A user reported their first REPL message rendering TWICE in scrollback: a
 * shorter copy WITHOUT the dim "[image attached]" summary, then the full card
 * WITH it. The session transcript proved the message was submitted exactly
 * ONCE, with its image (`## User … [+ 1 image]`), and the model answered using
 * the screenshot — so the duplication is a COSMETIC scrollback-render artifact,
 * not a double-submit or a lost image.
 *
 * A 108-geometry headless sweep (cols × rows × banner-height × stream-growth)
 * of the EXACT production commit path found the committed-band logic produces a
 * single correct copy at every geometry. That is consistent with the standing
 * observation in this subsystem (see `echo.ts` and `render/card.ts` last-column
 * invariants, and `first-turn-banner-echo.test.ts`): the visible triplicate /
 * duplicate echo is a real-terminal DECAWM deferred-wrap artifact
 * (iTerm2 / Ghostty / Kitty / WezTerm / tmux flush a pending wrap
 * inconsistently) that `@xterm/headless` — which implements autowrap
 * correctly — cannot reproduce. The mitigation the codebase relies on is
 * LAST-COLUMN SAFETY: no committed echo row may place a printable glyph in the
 * terminal's final column.
 *
 * ## What these tests lock
 *  1. PRODUCTION FIDELITY: the echo is committed as ONE block via
 *     `commitBlockAbove` (matching input-surface.ts:492), NOT per-line. The
 *     sibling `first-turn-banner-echo.test.ts` commits per-line — a stale
 *     mirror of production; this file exercises the real single-block path.
 *  2. SINGLE-COPY: after the first-turn commit + streaming growth + collapse,
 *     the separator, each body row, the `[image attached]` summary, and the
 *     response each appear EXACTLY ONCE in the rendered buffer.
 *  3. LAST-COLUMN SAFETY (the DECAWM proxy): every physical row of the echo —
 *     card rows AND the appended attachment-summary row — has a display width
 *     ≤ cols - 1, so nothing lands in the wrap-sensitive final column. This is
 *     the machine-checkable guarantee that guards the real-terminal artifact;
 *     a regression here is what resurfaces the "prompt echoed 3×" report.
 *
 * NOTE: these are GREEN guards. They do not reproduce the user-visible
 * duplication (impossible in the correct-autowrap headless terminal); they pin
 * the invariants whose violation would CAUSE it, for the exact echo shape
 * (multi-line card + attachment-summary trailer) that the prior suite missed.
 * The same single-block image-echo shape is ALSO driven end-to-end over a real
 * pseudo-terminal by the `first-turn-image-echo` scenario in tests/pty (#553),
 * which certifies the committed rows reach REAL scrollback exactly once — a
 * property mock-stdout cannot. That harness replays into @xterm/headless too,
 * so it likewise cannot surface the terminal-only DECAWM artifact; last-column
 * safety (test 2 below) stays the machine-checkable mitigation for that.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { LoopStageBar } from './commands/interactive/loop-stage.js';
import { formatSubmittedEcho } from './input/echo.js';
import { commitBlockAbove } from './_lib/commit-block.js';
import { displayWidth } from './display.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';

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
  statusLine.repaint({ model: 'MODELXYZ', cost: 0, tokens: 0, contextPct: 0 });
  const loopStageBar = new LoopStageBar({ getExtraRows: () => statusLine.getExtraRows(), stream: stdout });
  loopStageBar.setRowCountChangeHandler(() => statusLine.setExtraRows(1));
  statusLine.setAfterScrollRestore(() => loopStageBar.redraw());
  loopStageBar.start();
  return statusLine;
}

const COLS = 80;
const ROWS = 24;
const BANNER_ROWS = 11; // live geometry from first-turn-banner-echo.test.ts: anchorRow = 12
const SUMMARY = '[image attached]';

// A message long enough to wrap into a multi-row user card. DUPCHECK marks the
// first body region, `india` the tail — both must appear exactly once.
const MESSAGE =
  'these awa-private research agents being used are they actually from awa-private DUPCHECK ' +
  'or just titled that in agent-afk do we have our own research agents what tools india';

describe('first-turn echo with image attachment (single-block production path)', () => {
  it('commits the card + [image attached] summary exactly once and survives streaming growth', async () => {
    __resetStdinClaimForTests();
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

    // Pre-submit chrome collapse (spinner/hint/preflight → idle) — the 1-row
    // shrink-pad delta that reproduces the live first-commit geometry.
    c.setOverlay('preflight-line');
    c.setOverlay('');

    // First turn: build the echo the SAME way input-surface.ts does — a
    // multi-line user card PLUS the dim `[image attached]` summary row — and
    // commit it as ONE block via commitBlockAbove (input-surface.ts:492).
    const echo = formatSubmittedEcho({
      buffer: MESSAGE,
      promptText: 'afk (opus)  › ',
      isTTY: true,
      terminalWidth: COLS,
      attachmentSummary: SUMMARY,
    });
    const echoRows = echo.split('\n');
    // separator + ≥2 body rows + summary row.
    expect(echoRows.length).toBeGreaterThanOrEqual(4);
    expect(echoRows[echoRows.length - 1]).toContain(SUMMARY);
    commitBlockAbove(c, echoRows);
    c.commitAbove(''); // blank terminator (turn-handler.ts:236)

    // Streaming: spinner + overlay growth past the band, then a response
    // commit and collapse back to idle (the opus thinking → answer arc).
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

    // SINGLE-COPY: every distinct echo artifact appears exactly once.
    expect(ls.filter((l) => /─{10,}/.test(l)), `separator duplicated:\n${dump}`).toHaveLength(1);
    expect(ls.filter((l) => l.includes('DUPCHECK')), `body head duplicated/lost:\n${dump}`).toHaveLength(1);
    expect(ls.filter((l) => l.includes('india')), `body tail duplicated/lost:\n${dump}`).toHaveLength(1);
    expect(ls.filter((l) => l.includes(SUMMARY)), `attachment summary duplicated/lost:\n${dump}`).toHaveLength(1);
    expect(ls.filter((l) => l.includes('RESPONSE_OK')), `response duplicated:\n${dump}`).toHaveLength(1);

    // ORDER: banner → separator → body head → body tail → summary → response.
    const idx = (pred: (l: string) => boolean): number => ls.findIndex(pred);
    const lastBanner = ls.reduce((acc, l, i) => (l.includes('BANNER_LINE_') ? i : acc), -1);
    expect(lastBanner).toBeGreaterThanOrEqual(0);
    expect(idx((l) => /─{10,}/.test(l))).toBeGreaterThan(lastBanner);
    expect(idx((l) => l.includes('DUPCHECK'))).toBeGreaterThan(idx((l) => /─{10,}/.test(l)));
    expect(idx((l) => l.includes('india'))).toBeGreaterThan(idx((l) => l.includes('DUPCHECK')));
    expect(idx((l) => l.includes(SUMMARY))).toBeGreaterThan(idx((l) => l.includes('india')));
    expect(idx((l) => l.includes('RESPONSE_OK'))).toBeGreaterThan(idx((l) => l.includes(SUMMARY)));

    statusLine.stop();
    c.disarm();
  });

  it('every echo row (card + attachment summary) is last-column safe (DECAWM proxy)', () => {
    // The real-terminal duplication is a DECAWM deferred-wrap artifact triggered
    // by a printable glyph in the final column. The generator's guarantee is
    // that NO physical echo row reaches the last column. Assert it directly on
    // the produced echo for the image-attachment shape across representative
    // widths — the exact case the prior suite never exercised.
    //
    // Fidelity: production calls formatSubmittedEcho WITHOUT `terminalWidth`
    // (input-surface.ts), so echo.ts's summary/separator padding AND card()'s
    // body wrap BOTH read the live `getTerminalWidth()` (= process.stdout.columns).
    // Drive that single source per width so the two stay consistent exactly as
    // they do on a real terminal — passing `terminalWidth` to only one of them
    // would desync the card wrap from the summary pad and fabricate a failure.
    const origColumns = process.stdout.columns;
    try {
      for (const cols of [40, 60, 80, 100, 120]) {
        Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
        const echo = formatSubmittedEcho({
          buffer: MESSAGE,
          promptText: 'afk (opus)  › ',
          isTTY: true,
          attachmentSummary: SUMMARY,
        });
        for (const row of echo.split('\n')) {
          expect(
            displayWidth(row),
            `echo row exceeds last-column-safe width at cols=${cols}: ${JSON.stringify(row)}`,
          ).toBeLessThanOrEqual(cols - 1);
        }
      }
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: origColumns, configurable: true });
    }
  });
});
