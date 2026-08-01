import { describe, it, expect, afterEach } from 'vitest';
import stringWidth from 'string-width';
import { welcomeBanner } from './welcome-banner.js';

/**
 * Invariant (last-column safety): no welcome-banner row may end in the
 * terminal's final column. This matches the reserve already enforced by
 * `render/card.test.ts` and `input/echo.test.ts`, and it is what makes a
 * one-column shrink non-destructive (see welcome-banner.resize.test.ts, which
 * measures the actual reflow behaviour in a real emulator).
 *
 * Scope, stated plainly so this file is not mistaken for a resize fix: the
 * reported "goblin / AFK gets mangled on resize" is overflow reflow of
 * print-once scrollback rows, NOT a deferred-wrap/DECAWM effect. Reserving the
 * final column buys exactly one column of shrink headroom. It was still worth
 * doing — `render.test.ts` previously asserted rows were `<= cols`, which
 * admitted rows sitting exactly ON the final column, so the banner was the one
 * surface in `src/cli/` that violated a convention its siblings enforce.
 *
 * The trigger for exact-fill rows is that `truncateMiddle` / `truncateDisplay`
 * truncate TO their budget rather than below it, and a mascot row is composed as
 * 2-col pad + 27-col sprite + 2-col gutter + a right column budgeted at the
 * remainder — so a filled right column made the row exactly `cols` wide.
 */
describe('welcomeBanner last-column safety', () => {
  const prevCols = process.stdout.columns;

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: prevCols,
      configurable: true,
    });
  });

  /** Widest banner row at `cols`, measured in display cells with ANSI stripped. */
  const widestRow = (cols: number, cwd: string): number => {
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    const out = welcomeBanner({
      mode: 'Interactive Mode',
      model: 'opus_1m',
      worktree: 'afk/subagent-stream-cut-retry',
      cwd,
      version: '5.83.2',
      hintLine: '/help · /model · /resume · Esc to interrupt · /exit to quit',
    });
    // eslint-disable-next-line no-control-regex
    const strip = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');
    return Math.max(...out.split('\n').map((l) => stringWidth(strip(l))));
  };

  // A deep path forces `truncateMiddle` to emit exactly `colMaxW` cells, which
  // was the dominant real-world trigger (this operator's own worktree layout).
  const DEEP_CWD =
    '/Users/griffinlong/Projects/personal_projects/agent-workspace/agent-afk-private/deeply/nested';
  const SHALLOW_CWD = '/tmp/x';

  // Spans the mascot band (>= 56), the compact mascot-less fallback (< 56), and
  // the natural-width band where nothing truncates at all (>= 110).
  const WIDTHS = [40, 44, 48, 50, 55, 56, 60, 64, 70, 80, 90, 100, 107, 110, 120, 160];

  for (const cwd of [DEEP_CWD, SHALLOW_CWD]) {
    const label = cwd === DEEP_CWD ? 'deep cwd' : 'shallow cwd';
    it(`never writes into the final column at any width (${label})`, () => {
      for (const cols of WIDTHS) {
        expect(widestRow(cols, cwd), `cols=${cols} (${label})`).toBeLessThan(cols);
      }
    });
  }

  it('reserves the final column even when every info row overflows its budget', () => {
    // Every field oversized: each right-column row is truncated, so each one
    // lands exactly on its budget — the worst case for the reserve.
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    const out = welcomeBanner({
      mode: 'Interactive Mode With An Absurdly Long Mode Label',
      model: 'claude-opus-4-with-a-very-long-model-identifier',
      worktree: 'afk/a-very-long-worktree-branch-name-that-definitely-overflows',
      cwd: '/Users/example/projects/agent-afk/very/deep/nested/path/that/keeps/going',
      version: '5.83.2',
      metaLine: 'Resuming session 0199aa11-2b33-4c55-8d77-9e0011223344 from disk',
      hintLine: '/help · /model · /resume · /clear · Esc to interrupt · /exit to quit',
    });
    // eslint-disable-next-line no-control-regex
    const rows = out.split('\n').map((l) => stringWidth(l.replace(/\x1B\[[0-9;]*m/g, '')));
    expect(Math.max(...rows)).toBeLessThan(80);
  });
});
