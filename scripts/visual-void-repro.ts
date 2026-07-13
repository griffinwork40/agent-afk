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

type Scenario = 'long' | 'short' | 'grow-collapse' | 'resize';
const SCENARIOS: readonly Scenario[] = ['long', 'short', 'grow-collapse', 'resize'];

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

  await new Promise((r) => setTimeout(r, 6000));
  c.disarm();
  statusLine.stop();
  stdout.write(`\n[visual-void-repro:${arg} done — scroll up to inspect scrollback]\n`);
  process.exit(0);
}

void main();
