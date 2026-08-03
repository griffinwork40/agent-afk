import { describe, it, expect, afterEach } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { welcomeBanner } from './welcome-banner.js';

/**
 * History: root-cause record + regression guard for "sometimes the goblin / afk
 * in the banner gets mangled on resize", measured rather than reasoned. Replays
 * the REAL banner into `@xterm/headless` (a real emulator buffer + reflow engine)
 * and resizes it.
 *
 * The mechanism was ordinary overflow reflow of print-once scrollback content:
 *   - The banner is written once by `commands/interactive.ts` before the
 *     compositor arms, and is never re-derived at a new width.
 *   - No banner row carries the soft-wrap bit at print time — each is terminated
 *     by CR/LF, which resets the last-column flag (DEC STD-070). The
 *     deferred-wrap/DECAWM hazard behind the `card.ts`/`echo.ts` reserves does
 *     NOT apply here; that one needs a printable byte or a CUP with no
 *     intervening CR/LF. Pinned by the print-time assertion in `printBanner`.
 *   - On a SHRINK the emulator hard-splits any stored row wider than the new
 *     width. When session text rode BESIDE the sprite those rows were up to
 *     `cols` wide while sprite-only rows were 29, so a shrink split some rows of
 *     a fixed 13-row grid and injected text fragments into the goblin's face.
 *
 * The fix moved every readable string off the art rows (welcome-banner.ts,
 * "Invariant (no row mixes pixel art with text)"), leaving the widest art row at
 * LEFT_PAD + MASCOT_WIDTH + GUTTER + hero = 45 cols. The art therefore survives
 * any resize down to 45 — below MIN_INFO_COLS (56) the mascot isn't rendered at
 * all, so that covers its entire live range. Text rows below still reflow, which
 * is intended: wrapped prose degrades gracefully, torn pixel art does not.
 */
describe('welcomeBanner resize reflow (real emulator)', () => {
  const prevCols = process.stdout.columns;

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: prevCols,
      configurable: true,
    });
  });

  const BANNER_OPTS = {
    mode: 'Interactive Mode',
    model: 'opus_1m',
    worktree: 'afk/subagent-stream-cut-retry',
    cwd: '/Users/griffinlong/Projects/personal_projects/agent-workspace/agent-afk-private/deeply/nested',
    version: '5.83.2',
    hintLine: '/help · /model · Ctrl+D to quit',
  } as const;

  /** Any row carrying mascot half-blocks or block-art hero glyphs. */
  const isArtRow = (s: string): boolean => /[▀▄█]/.test(s);

  const readRows = (term: HeadlessTerminal): { text: string; wrapped: boolean }[] => {
    const buf = term.buffer.active;
    const out: { text: string; wrapped: boolean }[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.trim() === '') continue;
      out.push({ text, wrapped: line.isWrapped });
    }
    return out;
  };

  /** Print the banner rendered for `cols` into a fresh headless terminal. */
  const printBanner = async (cols: number): Promise<HeadlessTerminal> => {
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    const text = welcomeBanner({ ...BANNER_OPTS });
    const term = new HeadlessTerminal({ cols, rows: 44, allowProposedApi: true });
    // Real TTYs apply ONLCR (libuv keeps it set even in raw mode), so the
    // emulator sees CRLF — which is what resets the last-column flag.
    await new Promise<void>((resolve) => {
      term.write(text.split('\n').join('\r\n') + '\r\n', resolve);
    });
    // Nothing may be wrapped at print time: rows fit the width they were built
    // for. This rules out the deferred-wrap explanation for the mangling.
    for (const row of readRows(term)) {
      expect(row.wrapped, `wrapped at print time: |${row.text}|`).toBe(false);
    }
    return term;
  };

  const artAfterShrink = async (
    fromCols: number,
    toCols: number,
  ): Promise<{ before: string[]; after: string[]; wrappedArt: string[] }> => {
    const term = await printBanner(fromCols);
    const before = readRows(term).map((r) => r.text).filter(isArtRow);
    term.resize(toCols, 44);
    await new Promise<void>((resolve) => term.write('', resolve));
    const rowsAfter = readRows(term);
    const after = rowsAfter.map((r) => r.text).filter(isArtRow);
    const wrappedArt = rowsAfter.filter((r) => r.wrapped && isArtRow(r.text)).map((r) => r.text);
    term.dispose();
    return { before, after, wrappedArt };
  };

  it('keeps the goblin + AFK byte-identical through the shrink that used to mangle it', async () => {
    // 100 -> 60 is the reported case. Before the fix this split rows 10 and 12
    // (branch + cwd, both riding beside the sprite), inserting "ut-retry" and
    // "rkspace/..." into the middle of the art and pushing the jaw row down 2.
    const { before, after, wrappedArt } = await artAfterShrink(100, 60);
    expect(before.length).toBeGreaterThan(10); // sanity: the sprite really rendered
    expect(wrappedArt).toEqual([]);
    expect(after).toEqual(before);
  });

  it('keeps the art intact down to the 45-col art-block width', async () => {
    // The widest art row is 2 + 27 + 2 + 14 = 45. Shrinking to exactly that
    // leaves every art row within the new width, so none can split.
    const { before, after, wrappedArt } = await artAfterShrink(120, 45);
    expect(wrappedArt).toEqual([]);
    expect(after).toEqual(before);
  });

  it('holds across the whole live mascot range (mascot is dropped below 56)', async () => {
    // MIN_INFO_COLS drops the sprite under 56 cols, so 56 is the narrowest width
    // at which a freshly-rendered banner still contains art. Sweeping the band
    // guards against a future right-column addition re-widening the art rows.
    for (const to of [56, 64, 72, 80, 96]) {
      const { before, after, wrappedArt } = await artAfterShrink(140, to);
      expect(wrappedArt, `art split shrinking 140 -> ${to}`).toEqual([]);
      expect(after, `art changed shrinking 140 -> ${to}`).toEqual(before);
    }
  });

  it('still reflows the text rows below the art, by design', async () => {
    // Not a defect: prose rewraps legibly. This pins the intended asymmetry so a
    // future change that "fixes" it by re-widening art rows gets caught above.
    const term = await printBanner(100);
    term.resize(60, 44);
    await new Promise<void>((resolve) => term.write('', resolve));
    const wrappedText = readRows(term).filter((r) => r.wrapped && !isArtRow(r.text));
    expect(wrappedText.length).toBeGreaterThan(0);
    term.dispose();
  });
});
