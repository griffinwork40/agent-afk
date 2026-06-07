/**
 * Regression: verdict-card "bottom border cut off" bugs.
 *
 * Two independent defects, both reported via a screenshot where a Done card
 * rendered with its content + affordance visible but NO closing border `╰──╯`:
 *
 *  1. commitAbove's overflow path (block taller than the room above the live
 *     frame) top-anchored its viewport paint and clipped the LAST line — so a
 *     verdict card taller than the available rows above the tall REPL idle
 *     frame lost its closing border. Fix: tail-slice + bottom-anchor the
 *     overflow paint so the final line (closing border + affordance) survives;
 *     older top lines scroll into the Phase-1 scrollback archive instead.
 *     (src/cli/terminal-compositor.committed-band.ts)
 *
 *  2. Every affordance string contained an em-dash `—` (U+2014, East-Asian-Width
 *     Ambiguous). string-width counts it 1, but ambiguous-wide terminals render
 *     it 2, pushing the full-width affordance row 1 column past the box and
 *     wrapping the trailing `│`. Fix: ASCII-only affordances.
 *     (src/cli/commands/interactive/verdict-card.ts)
 *
 * This test drives the REAL renderVerdictCard + TerminalCompositor.commitAbove
 * pipeline (mirroring turn-handler's card → blank → footer sequence) into a
 * headless xterm and asserts the closing border survives in a tight frame.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import stringWidth from 'string-width';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { renderVerdictCard } from './commands/interactive/verdict-card.js';
import type { TerminalState, TerminalKind } from './commands/interactive/terminal-state.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
function makeMockStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true; s.columns = cols; s.rows = rows;
  return s;
}
function makeMockStdin() {
  const s = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean; setRawMode: ReturnType<typeof vi.fn> };
  s.isTTY = true;
  (s as unknown as { setRawMode: ReturnType<typeof vi.fn> }).setRawMode = vi.fn(() => s);
  return s;
}
function makeScrollRegion(stdout: MockStdout) {
  return {
    withFullScrollRegion<T>(fn: () => T): T {
      stdout.write('\x1b[s'); stdout.write('\x1b[r'); stdout.write('\x1b[u');
      try { return fn(); } finally {
        stdout.write('\x1b[s'); stdout.write(`\x1b[1;${stdout.rows}r`); stdout.write('\x1b[u');
      }
    },
    getExtraRows() { return 0; },
  };
}
function allLines(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active; const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line != null) out.push(line.translateToString(true));
  }
  return out;
}

const VERDICT: TerminalState = {
  kind: 'done',
  whatWasDone: 'Ran two parallel investigation lanes (CLI command handling + state storage), then verified the load-bearing claim directly in source.',
  evidence: 'Architecture summary above, every structural claim cited to file:line; non-atomic write confirmed by reading saveSession (session-store.ts:117-142).',
  deferred: 'The atomic-write fix is recommended, not applied (you asked for analysis). Say the word and I will implement it.',
  rawBody: '',
};

// A tall idle frame like the real REPL: loop-stage bar + ledger + prompt + status.
const TALL_IDLE_FRAME = [
  '  \u25e6 Tool-use loop',
  '    Iteration 3: used read_file \u00b7 3 tools \u00b7 4.4k tok',
  'afk > observe  model  choose  act  update',
  'ledger  done   (1 turn)',
  '~/x \u00b7 opus_1m \u00b7 3%',
].join('\n');

async function renderTurnIntoXterm(cols: number, rows: number): Promise<string[]> {
  const stdout = makeMockStdout(cols, rows);
  const chunks: string[] = [];
  stdout.on('data', (c: unknown) => chunks.push(String(c)));
  const stdin = makeMockStdin();
  const scrollRegion = makeScrollRegion(stdout);
  const c = new TerminalCompositor({ stdout, stdin, scrollRegion: scrollRegion as never });
  await c.arm();
  // Prior streamed prose pushes the screen near-full so the card commits into
  // tight room above the frame (forces commitAbove's overflow path).
  for (let i = 0; i < 8; i++) c.commitAbove(`prior streamed assistant prose line ${i}`);
  c.setOverlay(TALL_IDLE_FRAME);
  // Mirror turn-handler.ts: card -> blank -> footer.
  c.commitAbove(renderVerdictCard(VERDICT));
  c.commitAbove('');
  c.commitAbove('  \u25e6 3m 12s  \u00b7  7.3k tok');
  c.commitAbove('');

  const term = new HeadlessTerminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(chunks.join(''), resolve));
  return allLines(term);
}

describe('verdict card bottom border survives a tight frame (regression)', () => {
  it('renders the closing border ╰──╯ even when the card is taller than the room above the live frame', async () => {
    const lines = await renderTurnIntoXterm(80, 20);
    const grid = lines.filter((l) => l.trim()).join('\n');
    const hasTop = lines.some((l) => /╭─.*Done.*╮/.test(l));
    const hasBottom = lines.some((l) => /╰─+╯/.test(l));
    // The closing border is the load-bearing assertion — its absence is the
    // reported "cut off on the bottom" bug.
    expect(hasBottom, `bottom border ╰──╯ missing from rendered grid:\n${grid}`).toBe(true);
    // The affordance (the actionable end-of-turn line) must remain visible.
    expect(lines.some((l) => l.includes('Objective satisfied')), `affordance missing:\n${grid}`).toBe(true);
    // Sanity: the box opened too (top border present somewhere).
    expect(hasTop).toBe(true);
  });
});

describe('verdict card affordances are ambiguous-width safe (regression)', () => {
  it('affordance TEXT has no glyph that string-width measures differently in narrow vs wide mode', () => {
    const kinds: TerminalKind[] = ['done', 'blocked', 'asking', 'interrupted'];
    for (const kind of kinds) {
      const card = renderVerdictCard({ kind, rawBody: 'x' } as TerminalState);
      // Find the affordance row (the dim line just above the bottom border).
      const affordanceRow = card.split('\n').find((l) => /satisfied|dependency|Waiting|Halted/.test(l));
      expect(affordanceRow, `affordance row not found for ${kind}`).toBeTruthy();
      // Strip ANSI SGR + box-drawing chrome (U+2500–U+257F: the `│` rails),
      // leaving only the affordance TEXT. Box-drawing is itself EAW-ambiguous
      // but structurally unavoidable; the regression is an ambiguous glyph in
      // the TEXT (the em-dash), which overflows the full-width row and wraps
      // the trailing `│` on ambiguous-wide terminals.
      const text = affordanceRow!
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/[\u2500-\u257F]/g, '');
      const narrow = stringWidth(text, { ambiguousIsNarrow: true });
      const wide = stringWidth(text, { ambiguousIsNarrow: false });
      expect(
        wide,
        `${kind} affordance text has ambiguous-width glyph(s): narrow=${narrow} wide=${wide} in ${JSON.stringify(text)}`,
      ).toBe(narrow);
    }
  });
});
