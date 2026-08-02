/**
 * Space-fusion hunt (#thinking-spacing): can agent-afk's PAINT layer emit two
 * words fused into one ("relevant tests" -> "relevanttests") when a committed
 * block is re-wrapped across a WIDTH-CHANGE resize?
 *
 * Symptom under investigation: rendered terminal text intermittently loses a
 * single space between two words. afk's formatters (formatThinkingParagraph,
 * renderMarkdownToTerminal, wrapToWidth, hardWrapToWidth) and tmux reflow are
 * already proven clean; persisted transcripts hold the CORRECT spaced text.
 * The residual in-process suspect is the compositor paint layer:
 * terminal-compositor.band-reflow.ts (re-wrap at current width),
 * terminal-compositor.committed-band-commit.ts (hard-wrap at commit width),
 * terminal-compositor.scrollback.ts (logical-line rejoin into native history).
 *
 * TRIGGER CONDITION HUNTED: a wrap landing EXACTLY on the space between two
 * words. At that width the space is the boundary character — the row ends
 * with it (and any right-trim eats it) or it leads the next row. If any paint
 * site later REJOINS those rows without re-inserting the separator, the words
 * fuse. This sweeps every width where that boundary lands on each space in
 * the sentence, at commit width W1 then repaint width W2 (narrower AND wider).
 *
 * DETECTION MODEL (what counts as a real fusion): two words are fused only if
 * a SINGLE physical row — or a single archived scrollback LOGICAL line —
 * contains "relevanttests". A hard-wrap that puts "relevant" at the end of one
 * row and "tests" at the start of the next is NOT fusion: the terminal renders
 * them on separate lines. Concatenating right-trimmed rows would therefore
 * produce a false positive, so rows are checked individually.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { stripAnsi } from './display.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';
import { hardWrapToWidth } from './wrap.js';
import { reflowBandSplit } from './terminal-compositor.band-reflow.js';
import { buildBandMeta, scrollbackFlushLines } from './terminal-compositor.scrollback.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

function makeStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

interface Internals {
  repaint(): void;
  committedBand: string[];
  committedBandPaintedRows: number;
}

/** The sentence from the live symptom report, with the witness pair in it. */
const SENTENCE = 'I edited the relevant tests and ran the tests again to confirm';
/** Every fusion witness: the two words with their separating space removed. */
const SENTENCE_WORDS = SENTENCE.split(' ');
const FUSIONS = SENTENCE_WORDS.slice(1).map((word, i) => SENTENCE_WORDS[i] + word);

/** Column widths that place a hard-wrap boundary EXACTLY on each space. */
function widthsBreakingOnEachSpace(s: string): number[] {
  const out = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ') continue;
    // Row of width i ends right before the space; width i+1 ends ON it.
    out.add(i);
    out.add(i + 1);
    out.add(i + 2);
  }
  return [...out].filter((w) => w >= 4).sort((a, b) => a - b);
}

/** Assert no single row/line fuses a word pair. Returns the offending line. */
function findFusedLine(lines: readonly string[]): { line: string; token: string } | null {
  for (const raw of lines) {
    const line = stripAnsi(raw);
    for (const token of FUSIONS) {
      if (line.includes(token)) return { line, token };
    }
  }
  return null;
}

describe('paint layer — word/space fusion under width-change reflow', () => {
  const armed: TerminalCompositor[] = [];

  afterEach(() => {
    while (armed.length > 0) {
      try {
        armed.pop()?.disarm();
      } catch {
        /* idempotent */
      }
    }
    vi.useRealTimers();
  });

  it('PURE: hardWrapToWidth never drops the space at any width (incl. exact-on-space breaks)', () => {
    for (let w = 4; w <= 120; w++) {
      const rows = hardWrapToWidth(SENTENCE, w).split('\n');
      const fused = findFusedLine(rows);
      expect(fused, `width ${w} fused: ${JSON.stringify(fused)}`).toBeNull();
      // Content preservation: rejoining rows reproduces the sentence exactly.
      expect(rows.join(''), `width ${w} lost characters`).toBe(SENTENCE);
    }
  });

  it('PURE: reflowBandSplit (commit W1 -> repaint W2) preserves every space across all width pairs', () => {
    const interesting = widthsBreakingOnEachSpace(SENTENCE);
    const widths = [...new Set([...interesting, 8, 20, 40, 64, 80, 100, 160])].filter((w) => w >= 4);
    for (const w1 of widths) {
      const band = hardWrapToWidth(SENTENCE, w1).split('\n');
      const meta = buildBandMeta([SENTENCE], w1);
      for (const w2 of widths) {
        const r = reflowBandSplit(band, band.length, w2, meta);
        const fused = findFusedLine(r.rows);
        expect(fused, `W1=${w1} -> W2=${w2} fused: ${JSON.stringify(fused)}`).toBeNull();
        expect(r.rows.join(''), `W1=${w1} -> W2=${w2} lost characters`).toBe(SENTENCE);
        // The logical provenance that scrollback rejoin depends on must also
        // still carry the spaced text — this is the rejoin-fusion surface.
        for (const m of r.meta) {
          expect(findFusedLine([m.logicalText]), `W1=${w1}->W2=${w2} meta fused`).toBeNull();
        }
      }
    }
  });

  it('PURE: scrollbackFlushLines rejoin (physical rows -> logical line) never fuses', () => {
    for (const w1 of widthsBreakingOnEachSpace(SENTENCE)) {
      const band = hardWrapToWidth(SENTENCE, w1).split('\n');
      const meta = buildBandMeta([SENTENCE], w1);
      for (let count = 0; count <= band.length; count++) {
        const flushed = scrollbackFlushLines(band, meta, count);
        const fused = findFusedLine(flushed);
        expect(fused, `W1=${w1} count=${count} fused: ${JSON.stringify(fused)}`).toBeNull();
      }
      // Reflow to a WIDER width first (the rejoin-relevant case), then flush.
      const wide = reflowBandSplit(band, band.length, 200, meta);
      const flushedWide = scrollbackFlushLines(wide.rows, wide.meta, wide.rows.length);
      expect(findFusedLine(flushedWide), `W1=${w1} wide-reflow flush fused`).toBeNull();
      expect(flushedWide.join('\n')).toContain('relevant tests');
    }
  });

  it('E2E: real compositor — commit at W1, resize to W2, repaint; no painted row fuses words', async () => {
    // Sweep the exact-on-space widths as the POST-resize width (that is where
    // the re-wrap boundary lands on a space), against both a wider and a
    // narrower commit width.
    const targets = widthsBreakingOnEachSpace(SENTENCE).filter((w) => w >= 12 && w <= 70);
    const pairs: [number, number][] = [];
    for (const w2 of targets) {
      pairs.push([120, w2]); // shrink onto the space boundary
      pairs.push([w2, 120]); // grow off the space boundary
    }

    for (const [w1, w2] of pairs) {
      vi.useFakeTimers();
      const stdout = makeStdout(w1, 24);
      const stdin = makeStdin();
      const vscreen = new VirtualScreen(Math.max(w1, w2), 24);
      stdout.on('data', (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) vscreen.write(chunk as Buffer);
        else if (typeof chunk === 'string') vscreen.write(Buffer.from(chunk, 'utf-8'));
      });
      const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
      statusLine.start();
      statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
      const c = new TerminalCompositor({
        stdout,
        stdin,
        onCancel: vi.fn(),
        scrollRegion: statusLine,
        anchorRow: 1,
      });
      armed.push(c);
      await c.arm();
      statusLine.setExtraRows(2);
      c.setSpinner({ enabled: true });
      const internals = c as unknown as Internals;

      // Tall overlay -> band-hold, so the commit is retained in the model and
      // materialized only after the resize (the reflow-at-paint path).
      c.setOverlay(
        Array.from({ length: 22 }, (_, i) => `thinking ${i} — held overlay row`).join('\n'),
      );

      c.commitAbove(`${SENTENCE}\n\n`);

      // Pure-width SIGWINCH: immediate channel + debounced channel.
      stdout.columns = w2;
      process.stdout.emit('resize');
      vi.advanceTimersByTime(150);

      // Collapse the overlay -> band materializes and repaints at w2.
      c.setSpinner({ enabled: false });
      c.setOverlay('');
      internals.repaint();
      internals.repaint();

      const rows = [...vscreen.scrollbackLines(), ...vscreen.visibleLines()];
      const fused = findFusedLine(rows);
      expect(
        fused,
        `W1=${w1} -> W2=${w2} produced a fused row: ${JSON.stringify(fused)}`,
      ).toBeNull();

      // The in-memory band model must also stay unfused and space-preserving.
      expect(findFusedLine(internals.committedBand), `W1=${w1}->W2=${w2} band fused`).toBeNull();
      const bandText = internals.committedBand.map((l) => stripAnsi(l)).join('');
      expect(bandText.replace(/\s+/g, ' ').trim(), `W1=${w1}->W2=${w2} band lost content`).toBe(
        SENTENCE,
      );

      c.disarm();
      armed.pop();
      statusLine.stop?.();
      vi.useRealTimers();
    }
  }, 120_000);
});
