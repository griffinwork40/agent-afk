/**
 * Visual A/B repro for the collapse-void bug (run in a REAL terminal — iTerm2 /
 * Apple Terminal / xterm). The headless suite cannot certify real-PTY scrollback
 * (docs/scrollback.md:108-111), so this is the ground-truth check.
 *
 *   pnpm exec tsx scripts/visual-void-repro.ts
 *
 * A/B:
 *   git checkout main                        # BEFORE  → expect a big blank VOID
 *   pnpm exec tsx scripts/visual-void-repro.ts
 *   git checkout spike/compositor-retained-model   # AFTER → report contiguous
 *   pnpm exec tsx scripts/visual-void-repro.ts
 *
 * What you should see AFTER the fix: the whole report (HEADER + PROSE-01..06 +
 * the table + BODY-TAIL) sits as ONE contiguous block hugging the input prompt,
 * with NO multi-row blank gap in the middle, and the HEADER present (not lost).
 * BEFORE the fix: PROSE rows stranded up top, then a tall blank void, then the
 * table hugging the prompt — and the HEADER missing.
 *
 * The script renders, holds 6s so you can look + scroll up, then restores the
 * terminal and exits.
 */
import { TerminalCompositor } from '../src/cli/terminal-compositor.js';
import { StatusLine } from '../src/cli/status-line.js';
import { renderMarkdownToTerminal } from '../src/cli/formatter.js';

async function main(): Promise<void> {
  const stdout = process.stdout;
  if (!stdout.isTTY) {
    // eslint-disable-next-line no-console
    console.error('Not a TTY — run this directly in iTerm2 / Terminal / xterm, not through a pipe.');
    process.exit(2);
  }
  const cols = stdout.columns ?? 100;

  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model: 'visual-repro', cost: 0, tokens: 0, contextPct: 0 });
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

  // Tall overlay held across many small commits (the diagnose fan-out lane).
  const overlay = Array.from({ length: 22 }, (_, i) => `  thinking ${i} — held overlay keeping the frame tall`).join('\n');
  const commit = (s: string): void => { c.setOverlay(overlay); c.commitAbove(s); };

  commit('HEADER-MARKER  Diagnosis summary\n\n');
  for (let i = 1; i <= 6; i++) commit(`PROSE-${String(i).padStart(2, '0')}  report line of the streamed diagnosis\n\n`);
  const TABLE_MD = [
    '| # | Change | File | Nature |',
    '|---|--------|------|--------|',
    '| 1 | pass cwd to scheduler | scheduler.ts | behavior |',
    '| 2 | load config from cwd | config-loader.ts | behavior |',
    '| 3 | thread cwd through daemon | daemon.ts | plumbing |',
  ].join('\n');
  const table = renderMarkdownToTerminal(TABLE_MD, { maxWidth: cols - 2 }).replace(/\n+$/, '');
  commit(`${table}\nBODY-TAIL-ROW  final line of the report\n\n`);

  // Collapse: turn ends → spinner stops, overlay clears → minimal frame.
  c.setSpinner({ enabled: false });
  c.setOverlay('');
  const ix = c as unknown as { repaint(): void };
  ix.repaint();
  ix.repaint();

  await new Promise((r) => setTimeout(r, 6000));
  c.disarm();
  statusLine.stop();
  stdout.write('\n[visual-void-repro done — scroll up to inspect scrollback]\n');
  process.exit(0);
}

void main();
