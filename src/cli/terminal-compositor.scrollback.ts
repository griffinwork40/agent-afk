/**
 * Scrollback / ANSI-write pure helpers extracted from terminal-compositor.types.ts
 * (#826). These 7 functions carry the actual scrollback-flush algorithm and
 * escape-sequence construction for the committed band — genuine runtime
 * logic that a `.types.ts` name promised was absent. Split out so the file
 * name matches its contents; `terminal-compositor.types.ts` keeps only
 * interfaces/consts.
 *
 * Everything here is pure (no `self`/`this` — free functions, not
 * free-functions-on-host) and import-side-effect-free, same as before the
 * move. `BandRowMeta` stays defined in terminal-compositor.types.ts (several
 * of these functions consume it, but terminal-compositor.ts also imports the
 * type directly and is out of scope for this change), so it is imported
 * back here as a type-only import.
 */

import { palette } from './palette.js';
import { hardWrapToWidth } from './wrap.js';
import { displayWidth, truncateDisplayWidth } from './display.js';
import type { BandRowMeta } from './terminal-compositor.types.js';

export const ELAPSED_GRACE_MS = 2_000;

export function formatElapsed(startedAt: number): string {
  const elapsed = Date.now() - startedAt;
  if (elapsed < ELAPSED_GRACE_MS) return '';
  const totalSec = Math.floor(elapsed / 1000);
  if (totalSec < 60) return palette.dim(` ${totalSec}s`);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return palette.dim(` ${min}m${sec.toString().padStart(2, '0')}s`);
}

/**
 * Absolute-position erase-and-paint of one terminal row, returned as a string
 * for accumulation into a batched write (never written directly here).
 *
 * Emits CUP (`\x1b[{row};1H` — cursor to column 1 of `row`) then EL
 * (`\x1b[2K` — erase entire line), then `line`. Omitting `line` (or passing
 * `undefined`) erases the row and writes nothing — the bare-erase form.
 *
 * Invariant: emits NO `\n`, so callers that rely on CUP+EL writes never
 * triggering the DECSTBM scroll region stay correct. Shared by the
 * committed-band commit/repin and frame-preserve render paths, which batch
 * these into one `out` string before a single `stdout.write`.
 */
export function eraseAndPaintRow(row: number, line?: string): string {
  return `\x1b[${row};1H\x1b[2K${line ?? ''}`;
}

/**
 * Build the {@link BandRowMeta} array for a list of LOGICAL lines hard-wrapped
 * at `width` — the inverse-recording of the same
 * `logicalLines.flatMap((l) => hardWrapToWidth(l, width).split('\n'))` that
 * produces the physical `committedBand` rows, so the returned meta is
 * index-aligned 1:1 with those rows. A logical line that fits in `width` is a
 * single head row; one that overflows contributes a head row + N-1 continuation
 * rows all carrying the same `logicalText`.
 */
export function buildBandMeta(logicalLines: readonly string[], width: number): BandRowMeta[] {
  const meta: BandRowMeta[] = [];
  for (const logical of logicalLines) {
    const physicalCount = hardWrapToWidth(logical, width).split('\n').length;
    for (let i = 0; i < physicalCount; i++) {
      meta.push({ logicalText: logical, isHead: i === 0 });
    }
  }
  return meta;
}

/**
 * Translate the first `count` PHYSICAL rows of a band (the prefix being
 * scrolled off into native scrollback) into the lines to WRITE to scrollback,
 * emitting LOGICAL lines where a whole logical line lies within the prefix and
 * PHYSICAL rows verbatim where a logical line straddles the flush boundary
 * (#540 axis-2).
 *
 * Why: writing a raw logical line to the terminal with autowrap ON makes the
 * terminal own the wrapping, so its continuation rows are soft-wrap
 * continuations (isWrapped) that reflow cleanly on a later resize. Writing the
 * pre-hard-wrapped physical rows instead lands N hard-newline rows the terminal
 * can only reflow independently — the fragmentation bug.
 *
 * The straddle rule prevents both DUPLICATION and LOSS: if only some of a
 * logical line's physical rows are in the flush prefix (the rest stay on
 * screen), emitting the whole logical line would duplicate the on-screen tail
 * in scrollback once it reflowed to full height. So a straddling line's
 * in-prefix rows are emitted verbatim as physical rows (they stay
 * hard-newlined — acceptable, since the surviving on-screen tail can never
 * rejoin them anyway). A prefix whose first row is a continuation (`isHead:
 * false` at index 0 — a logical line whose head was sliced away by an earlier
 * eviction/cap) is likewise emitted verbatim. Every physical row in
 * `[0, count)` is accounted for exactly once, so the physical-row COUNT the
 * caller scrolls is unchanged whether a run emits as one logical line or as
 * verbatim rows — the terminal re-derives the same number of physical rows from
 * the logical line via its own autowrap (hardWrapToWidth is defined to match
 * the terminal's char-level wrap).
 *
 * `meta` must be index-aligned 1:1 with `rows` (see {@link BandRowMeta}).
 * Falls back to verbatim physical rows if `meta` is missing/short (defensive:
 * never lose content to a meta desync).
 */
export function scrollbackFlushLines(
  rows: readonly string[],
  meta: readonly BandRowMeta[] | undefined,
  count: number,
): string[] {
  const end = Math.max(0, Math.min(count, rows.length));
  if (!meta || meta.length < rows.length) {
    // No reliable provenance — emit the physical rows verbatim (pre-fix
    // behavior); correctness (content present) over rejoinability.
    return rows.slice(0, end);
  }
  const out: string[] = [];
  let i = 0;
  while (i < end) {
    if (!meta[i]?.isHead) {
      // A continuation row whose head is not in this prefix (sliced away
      // earlier): emit verbatim — its logical line is already fragmented.
      out.push(rows[i] ?? '');
      i += 1;
      continue;
    }
    // A logical-line head: find the extent of this logical line (until the
    // next head or the end of the array — NOT bounded by `count`, so we can
    // detect a straddle past the flush boundary).
    let j = i + 1;
    while (j < rows.length && !meta[j]?.isHead) j += 1;
    if (j <= end) {
      // The whole logical line is within the flush prefix → emit it ONCE as a
      // logical line (the terminal soft-wraps it; reflows cleanly on resize).
      out.push(meta[i]!.logicalText);
    } else {
      // Straddle: only rows [i, end) of this logical line are being flushed;
      // its tail stays on screen. Emit the in-prefix physical rows verbatim so
      // the on-screen tail is never duplicated in scrollback.
      for (let k = i; k < end; k++) out.push(rows[k] ?? '');
    }
    i = j;
  }
  return out;
}

/**
 * Snap a physical-row flush count DOWN to the nearest LOGICAL-line boundary
 * (#540 axis-2) so a scrollback archive never splits one logical line across
 * two archive events — which is what re-introduces the fragmentation even with
 * logical-line emission (a line archived one physical row at a time is emitted
 * verbatim each time, never as a whole soft-wrappable line).
 *
 * Given `meta` (per-physical-row provenance) and a desired `count` of leading
 * physical rows to flush, returns the largest `n <= count` such that either
 * `n === 0`, `n === meta.length`, or `meta[n]` is a logical-line head (i.e. the
 * cut falls exactly between two logical lines, never mid-line). The caller
 * archives `[0, n)` as whole logical lines and RETAINS the straddling line (and
 * everything after it) in the band model until a later flush covers all of its
 * rows. Returns `count` unchanged when `meta` is missing/short (the verbatim
 * fallback in {@link scrollbackFlushLines} then applies).
 */
export function snapFlushCountToLogicalBoundary(
  meta: readonly BandRowMeta[] | undefined,
  count: number,
  total: number,
): number {
  const c = Math.max(0, Math.min(count, total));
  if (!meta || meta.length < total) return c;
  if (c >= total) return total; // whole band flushes — always a clean boundary
  // Walk DOWN from c to the nearest logical-line head (a clean cut point).
  for (let n = c; n > 0; n--) {
    if (meta[n]?.isHead) return n;
  }
  return 0;
}

/**
 * Build the escape string that archives `lines` to native scrollback as
 * SOFT-WRAPPABLE content (#540 axis-2).
 *
 * Mechanism (verified against @xterm/headless + real pty): paint the lines at
 * the anchor floor as a normal top-of-screen text stream — each line CUP-less
 * after the first, separated by `\r\n`, with autowrap ON so the terminal wraps
 * an over-wide LOGICAL line itself (its continuation rows carry the terminal's
 * soft-wrap flag → reflow-clean on a later resize) — then CUP to the physical
 * bottom margin and emit `\n` × (total physical rows) to scroll the whole
 * painted block up and OFF the top into native scrollback. Writing at the
 * bottom-margin-only (the naive approach) leaves the content in the VIEWPORT,
 * never scrollback; writing at the top then scrolling the resident painted
 * height is what carries it into history. A line that fits the width is one physical
 * row and contributes one scroll — byte-equivalent outcome to the pre-#540
 * physical-row archive; a wide line contributes its wrapped height and rejoins
 * cleanly.
 *
 * Chunked by the paintable height (`rows - anchorFloor + 1`) so a block taller
 * than the terminal still archives every row: each chunk is painted top-aligned
 * and scrolled off before the next chunk. A chunk is scrolled by its RESIDENT
 * height — `min(chunkRows, chunkMax)` — not its full physical height: a SINGLE
 * line taller than the region cannot be split across chunks, so its paint does
 * overflow the bottom margin and the terminal auto-scrolls the excess itself.
 * Adding a full-height explicit scroll on top of that auto-scroll double-counts
 * and appends blank rows to history. `width` is needed to compute each line's
 * physical (wrapped) height; it MUST equal the terminal's current column count
 * so hardWrapToWidth's split matches what the terminal's autowrap will do.
 *
 * MUST run with autowrap ENABLED (the default) and inside the caller's
 * full-screen scroll region — the opposite of the on-screen band paint, which
 * runs inside `withAutowrapDisabled`. Autowrap is load-bearing HERE: it is what
 * makes the terminal, not the app, own the wrap so scrollback can later reflow.
 *
 * Returns '' for an empty list (caller writes nothing).
 */
export function buildScrollbackArchiveEscape(
  lines: readonly string[],
  anchorFloor: number,
  bottomRow: number,
  width: number,
): string {
  if (lines.length === 0) return '';
  const floor = Math.max(1, anchorFloor);
  const bottom = Math.max(1, bottomRow);
  const chunkMax = Math.max(1, bottom - floor + 1);
  const physicalHeight = (line: string): number =>
    Math.max(1, hardWrapToWidth(line, width).split('\n').length);
  let out = '';
  let chunk: string[] = [];
  let chunkRows = 0;
  const flushChunk = (): void => {
    if (chunk.length === 0) return;
    // External constraint (DECAWM autowrap owns the wrap): a chunk taller than
    // the paint region auto-scrolls `chunkRows - chunkMax` rows into history
    // DURING the paint, so only the rows still RESIDENT in the region may be
    // scrolled explicitly afterwards. `residentRows` is that count, and is the
    // single source of truth for both the pre-erase span and the scroll count.
    const residentRows = Math.min(chunkRows, chunkMax);
    // Erase every PHYSICAL row the paint will occupy, before painting it. The
    // per-line `\x1b[2K` below erases only each logical line's HEAD row; a line
    // that autowraps leaves its continuation rows unerased, so stale glyphs to
    // the right of the wrapped tail scroll into scrollback verbatim. Restores
    // the pre-#540 per-physical-row `eraseAndPaintRow` erase footprint exactly
    // (same span, no rows below the painted block touched).
    for (let r = 0; r < residentRows; r++) out += `\x1b[${floor + r};1H\x1b[2K`;
    // Paint the chunk top-aligned at the floor, flowing with \r\n so each
    // logical line starts on a fresh row and autowrap owns intra-line wrapping.
    out += `\x1b[${floor};1H`;
    out += chunk.map((l) => `\x1b[2K${l}`).join('\r\n');
    // Scroll the RESIDENT rows off the top into scrollback — not `chunkRows`:
    // for an over-height line the autowrap overflow already scrolled the
    // difference, and counting it twice appends `chunkRows - chunkMax` blank
    // rows to history.
    out += `\x1b[${bottom};1H${'\n'.repeat(residentRows)}`;
    chunk = [];
    chunkRows = 0;
  };
  for (const line of lines) {
    const h = physicalHeight(line);
    // A single line taller than the whole paint region gets its own chunk: the
    // terminal's autowrap scrolls the overflow beyond the region during the
    // paint, and flushChunk explicitly scrolls only the resident remainder, so
    // the two together carry exactly `h` rows into history.
    if (chunkRows > 0 && chunkRows + h > chunkMax) flushChunk();
    chunk.push(line);
    chunkRows += h;
  }
  flushChunk();
  return out;
}

/**
 * Format a loading tip into the dim 💡 row that sits beneath the spinner.
 *
 * The literal `Tip:` label is load-bearing, not decoration: most tips are
 * harvested skill hints shaped like `/agentify — Use when …`, and without
 * the label a tip rendered mid-turn reads as the agent announcing it is
 * routing to that skill (e.g. the user types `/automate` and immediately
 * sees `💡 /agentify — Use when…`). `Tip:` marks the row as ambient
 * guidance, decoupled from the in-flight turn. The {@link LoadingTip}
 * contract has always promised this prefix; the implementation drifted.
 *
 * `cols` is the terminal width — we truncate to fit on one visual line so
 * the tip never wraps and steals a viewport row that log-update can't
 * cleanly reclaim on the next paint. The prefix budget is "  💡 Tip: "
 * (10 visible cols); 1 more col is reserved for the trailing "…" when
 * truncation kicks in. Budget and truncation are measured in DISPLAY
 * columns (not JS chars) so wide glyphs (CJK, emoji) in a tip body cannot
 * overflow the row — char-count truncation would under-truncate them 2:1.
 */
export function formatTipRow(text: string, cols: number): string {
  const prefix = '  💡 Tip: ';
  // Reserve the prefix chrome and 1 col for the truncation marker so the
  // rendered line always fits in `cols` regardless of body length.
  const bodyBudget = Math.max(8, cols - displayWidth(prefix) - 1);
  const body =
    displayWidth(text) > bodyBudget
      ? truncateDisplayWidth(text, Math.max(0, bodyBudget - 1), '') + '…'
      : text;
  return palette.dim(prefix + body);
}
