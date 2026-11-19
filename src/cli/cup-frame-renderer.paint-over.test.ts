import { PassThrough } from 'node:stream';
import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { CupFrameRenderer } from './cup-frame-renderer.js';
import { hardWrapToWidth } from './wrap.js';

const cup = (row: number) => `\x1b[${row};1H`;
const write = (term: Terminal, data: string | Uint8Array): Promise<void> =>
  new Promise((resolve) => term.write(data, resolve));
function setup(cols = 112, rows = 37) {
  const stream = Object.assign(new PassThrough(), { columns: cols, rows, isTTY: true });
  const chunks: string[] = [];
  stream.on('data', (data: unknown) => chunks.push(String(data)));
  const renderer = new CupFrameRenderer(stream as unknown as NodeJS.WriteStream);
  const render = (text: string, bottom = rows - 1, floor?: number) => {
    chunks.length = 0;
    renderer.render(text, bottom, floor);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).not.toContain('\n');
    return chunks.join('');
  };
  return { renderer, render };
}
function terminal(cols = 112, rows = 37): Terminal {
  return new Terminal({ cols, rows, allowProposedApi: true });
}
function textRows(term: Terminal): string[] {
  return Array.from({ length: term.rows }, (_, i) =>
    term.buffer.active.getLine(i)?.translateToString(true) ?? '');
}
function cells(term: Terminal) {
  return Array.from({ length: term.rows }, (_, y) =>
    Array.from({ length: term.cols }, (_, x) => {
      const c = term.buffer.active.getLine(y)?.getCell(x);
      return [c?.getChars(), c?.getWidth(), c?.getFgColorMode(), c?.getFgColor(),
        c?.getBgColorMode(), c?.getBgColor(), c?.isBold(), c?.isInverse(), c?.isUnderline(),
        c?.isItalic(), c?.isDim(), c?.isBlink(), c?.isInvisible(), c?.isStrikethrough(), c?.isOverline()];
    }));
}
// Frozen reference: the previous erase-all, then CUP + EL2 + text ordering.
function oldRenderer(width: number) {
  let top = 0, count = 0, rawCount = 0;
  return (content: string, bottom: number, floor = 1, override?: number) => {
    bottom = Math.max(1, bottom);
    const lines = hardWrapToWidth(content.endsWith('\n') ? content : `${content}\n`, width).split('\n');
    while (lines.at(-1) === '') lines.pop();
    const raw = Math.max(1, lines.length);
    const pad = Math.min(Math.max(0, rawCount - raw), Math.max(0, bottom - raw + 1 - floor));
    const frame = [...Array<string>(pad).fill(''), ...lines];
    const nextTop = Math.max(1, bottom - frame.length + 1);
    let out = '\x1b[?2026h\x1b[?25l';
    for (let i = 0; i < count && top + i <= (override ?? bottom); i++) out += cup(top + i) + '\x1b[2K';
    frame.forEach((line, i) => { out += cup(nextTop + i) + '\x1b[2K' + line; });
    out += cup(nextTop + frame.length - 1) + '\x1b[?2026l';
    top = nextTop; count = frame.length; rawCount = raw;
    return out;
  };
}

for (const height of [12, 25]) {
  it(`never blanks a surviving row at ANY byte prefix (${height} styled rows)`, async () => {
    const { render } = setup();
    const frame = (version: number) => Array.from({ length: height }, (_, i) =>
      `\x1b[36m[tool ${i}]\x1b[39m \x1b[1mread_file\x1b[22m ` +
      `\x1b[2m${'src/cli/component.ts '.repeat(3)}\x1b[22m ` +
      `\x1b[38;2;180;190;200m\x1b[48;2;20;25;30mRUN\x1b[0m \x1b[33m${version}ms\x1b[39m`).join('\n');
    const prior = render(frame(1));
    const repaint = Buffer.from(render(frame(2)));
    expect(repaint.byteLength).toBeGreaterThan(2048);
    const term = terminal();
    try {
      await write(term, prior);
      const before = textRows(term);
      await write(term, repaint);
      const after = textRows(term);
      const surviving = before.flatMap((s, i) => s.trim() && after[i]?.trim() ? [i] : []);
      expect(surviving).toHaveLength(height);
      // Replay the repaint one byte per write into ONE terminal. The parser is
      // a streaming state machine (it carries split escapes and split UTF-8
      // across writes), so the screen after N single-byte writes is the screen
      // after one N-byte prefix. All writes are queued up front and each is
      // inspected in its own completion callback, which xterm runs right after
      // parsing that chunk and before the next one. Awaiting each write
      // instead costs one timer tick per byte, which timed out on the Windows
      // CI runner (coarse timers); the old-order run below would report zero
      // blank prefixes if the callbacks ever stopped observing mid-stream state.
      term.reset();
      await write(term, prior);
      let blankPrefixes = 0;
      let first = '';
      let checked = 0;
      await new Promise<void>((resolve) => {
        for (let end = 1; end <= repaint.byteLength; end++) {
          term.write(repaint.subarray(end - 1, end), () => {
            checked++;
            const rows = textRows(term);
            const blank = surviving.filter((r) => !rows[r]?.trim());
            if (blank.length) { blankPrefixes++; first ||= `byte ${end}, blank rows ${blank.map((r) => r + 1)}`; }
            if (end === repaint.byteLength) resolve();
          });
        }
      });
      expect(checked).toBe(repaint.byteLength);
      expect(textRows(term)).toEqual(after);
      expect(blankPrefixes, `${repaint.byteLength} prefixes; first: ${first}`).toBe(0);
    } finally { term.dispose(); }
  }, 30_000);
}

describe('paint-over hazards and old-order equivalence', () => {
  it('matches all cells of style-closed frames through grow/shrink/move/collapse and repin writes', async () => {
    const { render, renderer } = setup(16, 16);
    const old = oldRenderer(16);
    const actual = terminal(16, 16), reference = terminal(16, 16);
    const sequence: Array<[string, number, number?, number?]> = [
      ['long old tail\nsecond\nthird', 12], ['short', 12], ['again', 12],
      ['up\nnew', 11], ['down\nnew', 12],
      ['\x1b[41mred\x1b[49m\n\x1b[1;7mselected\x1b[0m', 12],
      ['1234567890123456\n界'.repeat(2), 12], ['\nblank above\n\ninput', 12],
      ['candidate1\ncandidate2\ncandidate3\ninput', 12], ['input', 7, 7, 12],
      ['input', 7, 7], ['growth\n\ninput', 9, 7], ['', 9], ['restored', 9],
    ];
    try {
      for (const [content, bottom, floor, override] of sequence) {
        if (override !== undefined) renderer.setEraseBottomOverride(override);
        await write(actual, render(content, bottom, floor));
        await write(reference, old(content, bottom, floor, override));
        expect(cells(actual), JSON.stringify([content, bottom])).toEqual(cells(reference));
        expect(actual.buffer.active.cursorX).toBe(reference.buffer.active.cursorX);
        expect(actual.buffer.active.cursorY).toBe(reference.buffer.active.cursorY);
        // Model the external repin painting into the padded footprint, not a row cache.
        const repin = cup(renderer.topRow) + '\x1b[2KCOMMITTED';
        await write(actual, repin); await write(reference, repin);
      }
    } finally { actual.dispose(); reference.dispose(); }
  });

  it('exhaustively compares style-closed row pairs, including attributes, widths and blank tails', async () => {
    const variants = ['', 'x', 'longer old tail', ' '.repeat(16), 'x'.repeat(16),
      'x'.repeat(17), '界'.repeat(8), 'a'.repeat(15) + '界',
      '\x1b[41mred\x1b[49m', '\x1b[48;2;1;2;3mRGB\x1b[49m',
      '\x1b[1;2;3;4;5;7;8;9;53mstyled\x1b[0m',
      '\x1b[31m' + 'x'.repeat(33) + '\x1b[39m'];
    const { render } = setup(16, 16);
    const old = oldRenderer(16);
    const actual = terminal(16, 16), reference = terminal(16, 16);
    try {
      for (const before of variants) {
        for (const after of variants) {
          for (const content of [before + '\ninput', after + '\ninput']) {
            await write(actual, render(content, 12));
            await write(reference, old(content, 12));
            expect(cells(actual), JSON.stringify([before, after, content])).toEqual(cells(reference));
          }
        }
      }
    } finally { actual.dispose(); reference.dispose(); }
  });

  it.each(['1234567890123456', '12345678901234界', '界'.repeat(8)])(
    'preserves the last cell (including double-width glyphs): %s', async (line) => {
      const { render } = setup(16, 8);
      const term = terminal(16, 8);
      try {
        await write(term, render('old old old old!', 6));
        const out = render(line, 6);
        await write(term, out);
        expect(textRows(term)[5]).toBe(line);
        expect(out).not.toContain('\x1b[K');
        // xterm retains an internal column past the margin during pending wrap.
        // Model terminals that keep it ON the last cell: EL0 destroys that glyph.
        await write(term, '\x1b[6;16H\x1b[K');
        expect(textRows(term)[5]).not.toBe(line);
      } finally { term.dispose(); }
    });

  it('hard-wraps overwidth styled and wide text before painting, without losing edge cells', async () => {
    const { render } = setup(16, 8);
    const term = terminal(16, 8);
    try {
      await write(term, render('\x1b[31m' + 'a'.repeat(15) + '界ZZ\x1b[39m', 6));
      expect(textRows(term).slice(4, 6)).toEqual(['a'.repeat(15), '界ZZ']);
    } finally { term.dispose(); }
  });

  it('records unclosed background policy: erase with ending attributes, preserve continuation', async () => {
    const { render } = setup(16, 8);
    const term = terminal(16, 8);
    try {
      await write(term, render('\x1b[41mred\nnext\x1b[49m', 6));
      expect(textRows(term).slice(4, 6)).toEqual(['red', 'next']);
      expect(term.buffer.active.getLine(4)?.getCell(0)?.getBgColor()).toBe(1);
      expect(term.buffer.active.getLine(4)?.getCell(12)?.getBgColor()).toBe(1);
      expect(term.buffer.active.getLine(5)?.getCell(0)?.getBgColor()).toBe(1);
      expect(term.buffer.active.getLine(5)?.getCell(12)?.isBgDefault()).toBe(true);
    } finally { term.dispose(); }
  });

  it('erases collapsed dropdown rows AFTER painting, consumes override even without a prior frame', async () => {
    const { render, renderer } = setup(16, 16);
    const term = terminal(16, 16);
    try {
      renderer.setEraseBottomOverride(15);
      expect(render('first', 12)).not.toContain('\x1b[2K');
      await write(term, render('at bottom', 15));
      await write(term, render('at top', 7, 7));
      expect(textRows(term)[14]).toBe('at bottom'); // first-render override was consumed
      await write(term, render('a\nb\nc\nd\ninput', 12));
      renderer.setEraseBottomOverride(12);
      const collapse = render('input', 7, 7);
      expect(collapse).toContain(cup(8) + '\x1b[2K');
      expect(collapse.indexOf('input')).toBeLessThan(collapse.indexOf(cup(8) + '\x1b[2K'));
      await write(term, collapse);
      expect(textRows(term).slice(6, 12)).toEqual(['input', '', '', '', '', '']);
      await write(term, cup(12) + 'FOOTER');
      await write(term, render('lower', 12, 12));
      await write(term, render('input', 7, 7));
      expect(textRows(term)[11]).toBe('lower'); // consumed override restores bottom clamp
    } finally { term.dispose(); }
  });

  it('removes long old tails and blanks explicit rows and shrink-pad rows, including repinned content', async () => {
    const { render, renderer } = setup(16, 12);
    const term = terminal(16, 12);
    try {
      await write(term, render('upper\nmiddle\na long old tail', 10));
      await write(term, render('x', 10));
      expect(textRows(term).slice(7, 10)).toEqual(['', '', 'x']);
      await write(term, cup(renderer.topRow) + 'REPinned');
      await write(term, render('head\n\nx', 10));
      expect(textRows(term).slice(7, 10)).toEqual(['head', '', 'x']);
    } finally { term.dispose(); }
  });
});
