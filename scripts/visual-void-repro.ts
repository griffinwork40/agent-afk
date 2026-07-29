/**
 * Visual A/B repro + Stage-4 validation matrix for the compositor scrollback-gap
 * class (run in a REAL terminal — iTerm2 / Apple Terminal / xterm). The headless
 * suite cannot certify real-PTY scrollback (docs/scrollback.md:108-111), so this
 * is the ground-truth check for #539 (minimal fix) and #540 (Stage 2 —
 * render-not-repin). Two prior fixes shipped headless-green and were broken in
 * reality; DO NOT trust green tests alone for this subsystem.
 *
 *   pnpm exec tsx scripts/visual-void-repro.ts [scenario]
 *
 * Non-interactive scenarios this script drives (pick one, default `long`):
 *   long            report + wide table under a tall overlay, then collapse
 *   short           a 3-line report under a tall overlay, then collapse
 *   grow-collapse   commit, grow the overlay taller, then collapse (re-pin path)
 *   resize          commit under a tall overlay, resize width mid-turn, collapse
 *   widen-evict     REFLOW axis (#540 axis-2) — commit under a SHORT frame, grow
 *                   the overlay so grow-eviction pushes those painted rows to
 *                   scrollback, collapse, then WAIT for you to drag the window
 *                   WIDER by hand. See the reflow-axis note below.
 *
 * Reflow axis vs. void axis — why `widen-evict` needs a human hand: the four
 * scenarios above check the VOID class (contiguity). `resize` does NOT check
 * reflow, because it fakes the resize by assigning `stdout.columns` and emitting
 * a synthetic 'resize' — the real terminal never resizes, so its scrollback is
 * never reflowed, and terminal-owned reflow is the whole mechanism of the
 * fragmentation bug. It also only ever narrows, and commits under a tall overlay
 * so it drives the band-hold archive (already fixed by #665) rather than
 * grow-eviction. Only a REAL OS window resize makes the emulator reflow its own
 * scrollback, so `widen-evict` sets the state up and then blocks on you.
 *
 * Interactive scenarios (run afk for real and eyeball — cannot be scripted as
 * pure output): dropdown headroom (open the slash-command menu on a fresh
 * session — the prompt must NOT jump) and picker (open a picker mid-session).
 *
 * A/B against the fix:
 *   git stash                                   # or: git checkout main
 *   pnpm exec tsx scripts/visual-void-repro.ts <scenario>   # BEFORE
 *   git checkout afk/fix-issue-540              # the Stage-2 branch
 *   pnpm exec tsx scripts/visual-void-repro.ts <scenario>   # AFTER
 *
 * PASS after the fix: the whole committed run sits as ONE contiguous block
 * hugging the input prompt — NO multi-row blank void in the middle, every row
 * present exactly once (the HEADER included), and nothing stranded up top. The
 * script renders, holds 6s so you can look + scroll up, then restores the
 * terminal and exits.
 */
import { TerminalCompositor } from '../src/cli/terminal-compositor.js';
import { StatusLine } from '../src/cli/status-line.js';
import { renderMarkdownToTerminal } from '../src/cli/formatter.js';

type Scenario = 'long' | 'short' | 'grow-collapse' | 'resize' | 'widen-evict';
const SCENARIOS: readonly Scenario[] = ['long', 'short', 'grow-collapse', 'resize', 'widen-evict'];

function tallOverlay(n: number): string {
  return Array.from({ length: n }, (_, i) => `  thinking ${i} — held overlay keeping the frame tall`).join('\n');
}

function reportTable(cols: number): string {
  const TABLE_MD = [
    '| # | Change | File | Nature |',
    '|---|--------|------|--------|',
    '| 1 | pass cwd to scheduler | scheduler.ts | behavior |',
    '| 2 | load config from cwd | config-loader.ts | behavior |',
    '| 3 | thread cwd through daemon | daemon.ts | plumbing |',
  ].join('\n');
  return renderMarkdownToTerminal(TABLE_MD, { maxWidth: cols - 2 }).replace(/\n+$/, '');
}

async function main(): Promise<void> {
  const stdout = process.stdout;
  if (!stdout.isTTY) {
    // eslint-disable-next-line no-console
    console.error('Not a TTY — run this directly in iTerm2 / Terminal / xterm, not through a pipe.');
    process.exit(2);
  }
  const arg = (process.argv[2] ?? 'long') as Scenario;
  if (!SCENARIOS.includes(arg)) {
    // eslint-disable-next-line no-console
    console.error(`Unknown scenario "${arg}". Pick one of: ${SCENARIOS.join(', ')}`);
    process.exit(2);
  }
  const cols = stdout.columns ?? 100;

  if (arg === 'widen-evict') {
    // Printed BEFORE arm() on purpose: the compositor stays LIVE through the
    // resize (that is the real-session case, and the case the PTY guard drives),
    // so nothing may write raw rows into its geometry once armed. A pre-arm print
    // is the same shape as the production banner and is safe.
    stdout.write(
      [
        '',
        '=== widen-evict — REFLOW axis (#540 axis-2) ===',
        `Start narrow. This pane is ${cols} cols; 48-70 is ideal. Resize it NOW if wider.`,
        '',
        'After the render settles you get 45s. During that window:',
        '  1. DRAG THIS WINDOW WIDER (or press cmd-minus to shrink the font).',
        '  2. Scroll up to the LONGLINE-MARKER … END-OF-LONGLINE line.',
        '       FAIL  it is split across rows breaking MID-WORD, continuations at col 0',
        '       PASS  it rejoined into one soft-wrapped paragraph',
        '  3. Confirm CARD-BOTTOM is still present — the previous logical-archive',
        '     attempt dropped exactly that border row on a growth eviction.',
        '',
      ].join('\n') + '\n',
    );
  }

  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model: `visual-repro:${arg}`, cost: 0, tokens: 0, contextPct: 0 });
  const c = new TerminalCompositor({
    stdout,
    stdin: process.stdin,
    onCancel: () => {},
    scrollRegion: statusLine,
    anchorRow: 1,
  });
  await c.arm();
  statusLine.setExtraRows(1);
  c.setSpinner({ enabled: true });

  const overlay = tallOverlay(22);
  const commit = (s: string): void => {
    c.setOverlay(overlay);
    c.commitAbove(s);
  };
  const ix = c as unknown as { repaint(): void };
  const collapse = (): void => {
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    ix.repaint();
    ix.repaint();
  };

  if (arg === 'short') {
    commit('HEADER-MARKER  Short diagnosis\n\n');
    commit('PROSE-01  the one and only body line of a short report\n\n');
    commit('BODY-TAIL-ROW  final line\n\n');
    collapse();
  } else if (arg === 'grow-collapse') {
    commit('HEADER-MARKER  Diagnosis summary\n\n');
    for (let i = 1; i <= 4; i++) commit(`PROSE-${String(i).padStart(2, '0')}  report line\n\n`);
    // Grow the overlay taller mid-turn (re-pin / evict-on-growth path), then collapse.
    c.setOverlay(tallOverlay(30));
    ix.repaint();
    commit('BODY-TAIL-ROW  committed after the growth\n\n');
    collapse();
  } else if (arg === 'widen-evict') {
    // Commit under a SHORT frame (no overlay) so these rows land in the band and
    // are CUP-painted as hard-wrapped PHYSICAL rows — deliberately NOT routed to
    // the band-hold archive that #665 converted to logical lines.
    c.setOverlay('');
    c.commitAbove(`LONGLINE-MARKER ${'reflow '.repeat(24)}END-OF-LONGLINE\n\n`);
    // A boxed card whose CLOSING BORDER is the row the previous logical-archive
    // attempt dropped on a growth eviction (frame-preserve.ts:10-30). Keeping it
    // in view means that regression cannot pass unnoticed.
    c.commitAbove(
      '┌─ CARD-TOP ───────────────┐\n│ card body row            │\n└─ CARD-BOTTOM ────────────┘\n\n',
    );
    for (let i = 1; i <= 4; i++) c.commitAbove(`PROSE-${String(i).padStart(2, '0')}  report line\n\n`);
    ix.repaint();
    // Grow the frame: preserveRowsBeforeFrameRender evicts the painted rows above
    // into scrollback as app hard newlines — the site the PTY guards cannot see.
    c.setOverlay(tallOverlay(30));
    ix.repaint();
    collapse();
  } else {
    // `long` and `resize` share the report+table body.
    commit('HEADER-MARKER  Diagnosis summary\n\n');
    for (let i = 1; i <= 6; i++) commit(`PROSE-${String(i).padStart(2, '0')}  report line of the streamed diagnosis\n\n`);
    commit(`${reportTable(cols)}\nBODY-TAIL-ROW  final line of the report\n\n`);
    if (arg === 'resize') {
      // Simulate a width change mid-turn: the band must reflow + stay gap-free.
      (stdout as unknown as { columns: number }).columns = Math.max(40, cols - 20);
      stdout.emit('resize');
      ix.repaint();
    }
    collapse();
  }

  // widen-evict needs a human to physically resize the OS window mid-hold, so it
  // holds far longer than the look-and-scroll scenarios.
  await new Promise((r) => setTimeout(r, arg === 'widen-evict' ? 45000 : 6000));
  c.disarm();
  statusLine.stop();
  stdout.write(`\n[visual-void-repro:${arg} done — scroll up to inspect scrollback]\n`);
  process.exit(0);
}

void main();
