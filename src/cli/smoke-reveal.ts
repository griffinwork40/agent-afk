/**
 * Text reveal mask: streamed characters arrive softly instead of popping in.
 *
 * Two styles share one mask (see smoke-reveal.cells.ts for the look):
 *  - `ink` (the default for prose): a letter rises from just above the
 *    background into its OWN color, like ink drying, and never passes
 *    through a brighter tone than it settles on. `AFK_INK_TEXT=0` disables it.
 *  - `smoke` (the accent, opt-in via `AFK_SMOKE_TEXT=1`): heading lines
 *    condense out of braille particles, with a thin wisp drifting ahead of
 *    the front. Body prose stays ink, so smoke remains a moment.
 *
 * How it works:
 *  - `record(chunk)` runs when raw markdown enters the pipeline. It splits
 *    the chunk into heading / other runs and appends them to a continuous
 *    playhead (`RevealTimeline`, smoke-reveal.playhead.ts) that births each
 *    character as it crosses it. The playhead accelerates and decelerates
 *    smoothly with the backlog, so a network lump sweeps in quickly instead
 *    of landing as a block and a stall eases to rest over several frames.
 *    Intake bounds nominal queued animation duration with `MAX_LAG_MS`
 *    (headings: `ACCENT_MAX_LAG_MS`), settling older overflow immediately.
 *    These budgets are capacities, not strict arrival-to-birth deadlines.
 *  - `apply(formatted)` runs on the formatted pending overlay just before it
 *    is painted. It walks the visible characters, tracking the active SGR
 *    style, and restyles the youngest ones by age. Characters not yet born
 *    are drawn as blank cells of the same width.
 *
 * Invariant (pace the REVEAL, never the TEXT): every character is in the
 * buffer, laid out and committed exactly as it would be with the reveal off.
 * Only its styling (and blank-until-born) changes. An earlier version paced
 * text INTO the buffer instead; that grew the overlay one row at a time
 * (each growth at the bottom of the screen is a full compositor repaint, a
 * visible flicker) and held every paragraph in the overlay until its commit
 * (a shrink repaint per paragraph). Reserved blank cells keep the layout
 * identical to reveal-off, so the reveal cannot cause either.
 *
 * Invariant (age mapping by distance-from-end): ages are keyed by how far a
 * character sits from the END of the text, counting non-whitespace grapheme
 * clusters only. New text always lands at the end, and a block commit only
 * removes text from the FRONT, so distance-from-end survives commits,
 * re-wrapping, indentation, and centering margins unchanged. Births are
 * monotonic, so the characters not yet born are exactly the newest few.
 *
 * Invariant (raw vs formatted counts): `record()` sees RAW markdown, but
 * `apply()` indexes the FORMATTED overlay, and the formatter consumes syntax
 * (`**`, backticks, `## `). Each `apply()` compares how much the formatted
 * text grew since the previous apply against how much raw text was recorded
 * and trims the excess from the newest bursts. `noteCommit()` drops the
 * baseline whenever text leaves the FRONT of the overlay; the first frame
 * after a commit is left unreconciled, which is harmless.
 *
 * Invariant (settle driver): while any character is still settling,
 * `apply()` marks ONE steady 60 fps `FrameClock` dirty
 * (markdown-stream.frame-clock.ts), which calls the owner's `paint` callback
 * once per period on a drift-corrected grid. While `animating`, the owner
 * routes its own repaint requests into `markDirty()` instead of painting, so
 * content pushes never add a second paint in a period. The clock stops (its
 * one timer is released) on the first frame where nothing is settling.
 *
 * Contract: this module never delays a block commit itself. Committed blocks
 * render through `formatBlockForCommit`, untouched by the mask. The OWNER may
 * defer one: markdown-stream.commit-defer.ts keeps a completed block pending
 * (text keeps flowing behind it) until `revealHoldRemaining(d)` for its last
 * letter reaches 0, bounded in time, so a paragraph finishes fading before it
 * commits. Without that, at model stream rates most of each paragraph was
 * still fading at its commit and snapped solid. Renders the mask skips are
 * never deferred, and the commit itself still goes through
 * `syncPendingOverlay` in markdown-stream.ts.
 *
 * @module cli/smoke-reveal
 */

import chalk from 'chalk';
import stringWidth from 'string-width';
import { env, isPlainOutputRequested } from '../config/env.js';
import { isExplicitlyDisabled, isExplicitlyEnabled } from '../config/env-helpers.js';
import { countVisible, segmentAnsi } from './smoke-reveal.ansi.js';
import { SMOKE_GLYPH_LEVELS } from './smoke-reveal.frame.js';
import { LineClassifier } from './smoke-reveal.lines.js';
import { FRAME_PERIOD_MS, FrameClock } from './markdown-stream.frame-clock.js';
import { HEADING_MAX_CPS, MAX_CPS, RevealTimeline } from './smoke-reveal.playhead.js';
import { applySgr, EMPTY_SGR, isSgr, serializeSgr, type SgrState } from './smoke-reveal.sgr.js';
import {
  INK_MS,
  MAX_LIFETIME_MS,
  SMOKE_GLYPH_PHASE,
  SMOKE_MS,
  WISP_CELLS,
  inkCell,
  lifetimeOf,
  smokeCell,
  wispCell,
  wispCells,
  type RevealStyle,
} from './smoke-reveal.cells.js';

export type { RevealStyle } from './smoke-reveal.cells.js';
export { INK_MS } from './smoke-reveal.cells.js';

/** Smoke-accent lifetime: first speck to fully settled letter. */
export const LIFETIME_MS = SMOKE_MS;
/** Fraction of the smoke lifetime spent as a particle before the letter shows. */
export const GLYPH_PHASE = SMOKE_GLYPH_PHASE;
/** Historical floor spacing between prose characters. The playhead's prose ceiling is `MAX_CPS`. */
export const STAGGER_MS = 6;
/**
 * Nominal queued-animation duration budget for prose, not an arrival deadline.
 * Invariant: run capacity is `MAX_LAG_MS * MAX_CPS` characters (playhead
 * record), so this scales inversely with `MAX_CPS` to hold capacity at 360.
 * Lowering the ceiling alone shrinks capacity and turns "slower" into
 * overflow chunks snapping solid.
 */
export const MAX_LAG_MS = 2000;
/** Minimum spacing for heading lines (`HEADING_MAX_CPS`): slower, so the smoke has room to roll. */
export const ACCENT_STAGGER_MS = 18;
/** Nominal queued-animation duration budget for heading lines. */
export const ACCENT_MAX_LAG_MS = 900;
/** Share of a smoke letter's life a held heading waits for before it may commit (eased: nearly solid). */
export const SMOKE_HOLD_SHARE = 0.75;
/** Share of an ink letter's fade a deferred block commit waits for. */
export const INK_HOLD_SHARE = 0.75;
/** Re-check interval for a deferred commit whose last letter is not born yet. */
export const HOLD_RECHECK_MS = 32;
/** Settle-driver cadence: the frame clock's 60 fps period. */
export const FRAME_MS = FRAME_PERIOD_MS;
/**
 * Every smoke glyph the reveal can draw, faintest density level first (see
 * `SMOKE_GLYPH_LEVELS` in smoke-reveal.frame.ts for the narrow-width
 * invariant). The ahead-of-front wisp draws from the same set.
 */
export const SMOKE_GLYPHS: readonly string[] = SMOKE_GLYPH_LEVELS.flat();

const RESET = '\u001b[0m';

export interface RecordOptions {
  /** Force one style for the whole chunk (skips heading detection). */
  style?: RevealStyle;
  /**
   * Minimum spacing between this chunk's characters (speed ceiling
   * `1000 / staggerMs` cps). `0` reveals the chunk instantly. Default: the
   * playhead's `MAX_CPS` for prose, `HEADING_MAX_CPS` for headings.
   */
  staggerMs?: number;
  /**
   * Extra queued-animation budget for this chunk, in ms. The renderer passes
   * how long a chunk sat in a commit hold, so text released from a hold
   * animates instead of landing as overflow (the backlog is still bounded:
   * later intakes settle against their own budgets).
   */
  extraBudgetMs?: number;
}

export interface RevealStyles {
  /** Style for body text. Default `smoke` (the historical behavior). */
  prose?: RevealStyle;
  /** Style for markdown heading lines. Default: same as `prose`. */
  headings?: RevealStyle;
}

export interface ApplyOptions {
  /**
   * Column budget of one overlay line. When given, a smoke front may draw its
   * wisp in the empty cells after it, but only if the whole line still fits.
   * Omitted: no wisp, and the output is column-for-column the input.
   */
  maxWidth?: number;
}

/** Terminal can show the reveal at all: not plain-output, and 256+ colors (so not NO_COLOR/CI/non-TTY). */
function canReveal(): boolean {
  return !isPlainOutputRequested() && chalk.level >= 2;
}

/** Smoke accent: `AFK_SMOKE_TEXT` is explicitly enabled on a capable terminal. */
export function isSmokeTextEnabled(): boolean {
  const raw = env.AFK_SMOKE_TEXT;
  if (!raw || !isExplicitlyEnabled(raw)) return false;
  return canReveal();
}

/** Ink reveal (default for prose): on unless `AFK_INK_TEXT` is explicitly disabled, on a capable terminal. */
export function isInkTextEnabled(): boolean {
  const raw = env.AFK_INK_TEXT;
  if (raw && isExplicitlyDisabled(raw)) return false;
  return canReveal();
}

interface Front {
  birth: number;
  style: RevealStyle;
  /** Style active after the newest character (restored after an inserted wisp). */
  state: SgrState;
  /** Index into the output parts just after the newest character. */
  at: number;
  /** Width of the newest character's line, filled in when the line ends. */
  lineWidth: number | null;
}

export class SmokeReveal {
  private readonly timeline = new RevealTimeline();
  private readonly clock: FrameClock;
  /**
   * Reconciled characters recorded over this instance's life. The character
   * `d` positions from the end has the stable identity `serial - 1 - d`: new
   * text raises both `serial` and `d` by the same amount, and a commit
   * removes text from the front without changing either.
   */
  private serial = 0;
  /** Visible count at the last walked apply(); null = no valid baseline. */
  private lastVisible: number | null = null;
  /** Raw visible characters recorded since the last walked apply(). */
  private sinceApply = 0;

  /** Segmentation of the last formatted string: a frame repaint of unchanged text reuses it. */
  private segCache: { text: string; segs: ReturnType<typeof segmentAnsi>; visible: number } | null = null;

  private readonly lines = new LineClassifier();
  private readonly prose: RevealStyle;
  private readonly headings: RevealStyle;

  /** `paint` must paint immediately (unthrottled): the frame clock already paces it. */
  constructor(
    paint: () => void,
    private readonly now: () => number = Date.now,
    styles: RevealStyles = {},
  ) {
    this.clock = new FrameClock(paint);
    this.prose = styles.prose ?? 'smoke';
    this.headings = styles.headings ?? this.prose;
  }

  /** Register newly arrived raw text. Whitespace-only chunks are ignored. */
  record(chunk: string, opts: RecordOptions = {}): void {
    const t = this.now();
    const runs = opts.style
      ? [{ text: chunk, heading: false, style: opts.style }]
      : this.lines.split(chunk).map((r) => ({ ...r, style: r.heading ? this.headings : this.prose }));
    for (const run of runs) {
      const count = countVisible(run.text);
      if (count === 0) continue;
      const ceiling = run.heading ? HEADING_MAX_CPS : MAX_CPS;
      const maxCps = opts.staggerMs === undefined ? ceiling : opts.staggerMs <= 0 ? Infinity : 1000 / opts.staggerMs;
      const capMs = (run.heading ? ACCENT_MAX_LAG_MS : MAX_LAG_MS) + Math.max(0, opts.extraBudgetMs ?? 0);
      this.timeline.record(t, { count, style: run.style, capMs, maxCps });
      this.sinceApply += count;
    }
    this.prune(t);
  }

  /**
   * Milliseconds until the newest characters, if they are smoke, have
   * condensed enough (`SMOKE_HOLD_SHARE` of their life) to be committed
   * without a visible snap. 0 when the newest character is not smoke.
   */
  smokeHoldRemaining(): number {
    const t = this.now();
    this.timeline.advance(t);
    const tl = this.timeline;
    const birth = tl.styleAt(tl.recorded - 1) === 'smoke' ? tl.newestBirthEstimate(t) : null;
    return birth === null ? 0 : Math.max(0, birth + SMOKE_MS * SMOKE_HOLD_SHARE - t);
  }

  /**
   * Milliseconds until the character `d` positions from the end (0 = newest),
   * of either style, is far enough through its fade (`SMOKE_HOLD_SHARE` /
   * `INK_HOLD_SHARE`) to be committed without a visible snap. While it is still unborn its birth is not yet
   * known, so this returns the short `HOLD_RECHECK_MS` re-check interval
   * rather than a pessimistic estimate. 0 when settled or nothing is tracked.
   */
  revealHoldRemaining(d = 0): number {
    const t = this.now();
    this.timeline.advance(t);
    const tl = this.timeline;
    const i = tl.recorded - 1 - d;
    if (i < tl.first || tl.isSettled(i)) return 0;
    const birth = tl.birthAt(i);
    const style = tl.styleAt(i);
    if (birth === null || style === undefined) return 0;
    if (birth === Infinity) return HOLD_RECHECK_MS;
    const dwell = style === 'smoke' ? SMOKE_MS * SMOKE_HOLD_SHARE : INK_MS * INK_HOLD_SHARE;
    return Math.max(0, birth + dwell - t);
  }

  /**
   * Style the youngest characters of `formatted` by age. Returns `formatted`
   * unchanged (same reference) when nothing is animating.
   */
  apply(formatted: string, opts: ApplyOptions = {}): string {
    const t = this.now();
    this.prune(t);
    const tl = this.timeline;
    if (tl.recorded === tl.first || formatted === '') return formatted;

    const { segs, visible } = this.segment(formatted);
    this.reconcile(visible);

    // Characters at or beyond the tracked count are settled by definition,
    // so skip the timeline lookup for them (most of a long paragraph).
    const recorded = tl.recorded - tl.first;
    // Births are monotonic, so the unborn characters are exactly the newest
    // `unborn`, and the revealed front is the character just before them.
    const unborn = Math.min(recorded, tl.recorded - tl.bornCount);
    const lead = unborn < recorded ? this.birthOf(unborn) : null;
    // Stable identity of the revealed front: the wisp's texture is seeded from
    // it, so appending text (which moves `serial`) never reshuffles the wisp.
    const leadSeed = this.serial - 1 - unborn;
    const parts: string[] = [];
    let state: SgrState = EMPTY_SGR;
    let col = 0;
    let idx = 0;
    let animating = false;
    let front: Front | null = null;
    for (const s of segs) {
      if (s.kind === 'raw') {
        if (isSgr(s.text)) state = applySgr(state, s.text);
        parts.push(s.text);
        continue;
      }
      if (s.ws) {
        if (s.text.includes('\n')) {
          if (front && front.lineWidth === null) front.lineWidth = col;
          col = 0;
        } else col += stringWidth(s.text);
        parts.push(s.text);
        continue;
      }
      const d = visible - 1 - idx;
      const hit = d >= recorded ? null : this.birthOf(d);
      idx++;
      const w = stringWidth(s.text);
      col += w;
      if (hit === null) {
        parts.push(s.text);
        continue;
      }
      const age = t - hit.birth;
      const seed = this.serial - 1 - d;
      let cell: string | null;
      if (age < 0) cell = this.reservedCell(unborn - d, w, lead, t, leadSeed);
      else if (hit.style === 'ink') cell = inkCell(s.text, age, state, d - unborn);
      else cell = smokeCell(s.text, age, seed, state);
      parts.push(cell ?? s.text);
      if (cell !== null) animating = true;
      if (d === 0 && age >= 0) front = { birth: hit.birth, style: hit.style, state, at: parts.length, lineWidth: null };
    }
    if (front && front.lineWidth === null) front.lineWidth = col;
    if (this.insertWisp(parts, front, t, opts.maxWidth)) animating = true;
    if (animating) this.clock.markDirty();
    return animating ? parts.join('') + RESET : formatted;
  }

  /** True while the frame clock is driving repaints (some character is still settling). */
  get animating(): boolean {
    return this.clock.running;
  }

  /** Ask the frame clock for a paint on its next tick (owner repaint requests while `animating`). */
  markDirty(): void {
    this.clock.markDirty();
  }

  /** Text just left the FRONT of the overlay (a block commit). */
  noteCommit(): void {
    this.lastVisible = null;
  }

  /**
   * Forget the `count` newest characters (a stripped pending tail) while the
   * kept text keeps its own reveal history. The growth baseline is dropped
   * because the overlay just shrank at the END, not by a front commit.
   */
  forgetNewest(count: number): void {
    this.timeline.trimNewest(count);
    this.lastVisible = null;
  }

  /** Forget all history (e.g. the pending buffer was discarded). */
  reset(): void {
    this.timeline.reset();
    this.segCache = null;
    this.lines.reset();
    this.lastVisible = null;
    this.sinceApply = 0;
    this.clock.stop();
  }

  /** Stop the settle driver and clear all history. Safe to call repeatedly. */
  dispose(): void {
    this.reset();
  }

  /**
   * A not-yet-born cell `k` positions ahead of the revealed front: blank, or
   * a wisp particle when the front is smoke. Always exactly `width` columns.
   */
  private reservedCell(k: number, width: number, lead: { birth: number; style: RevealStyle } | null, t: number, seed: number): string {
    const blank = ' '.repeat(Math.max(1, width));
    if (!lead || lead.style !== 'smoke' || width !== 1) return blank;
    const wisp = wispCell(k, t - lead.birth, t, seed);
    return wisp ? wisp + RESET : blank;
  }

  /** Splice the drifting wisp after a smoke front at the very end of the text, when the line has room. */
  private insertWisp(parts: string[], front: Front | null, t: number, maxWidth: number | undefined): boolean {
    if (!front || front.style !== 'smoke' || maxWidth === undefined) return false;
    if ((front.lineWidth ?? 0) + WISP_CELLS > maxWidth) return false;
    const wisp = wispCells(t - front.birth, t, this.serial - 1);
    if (!wisp) return false;
    parts.splice(front.at, 0, wisp + serializeSgr(front.state));
    return true;
  }

  /**
   * Trim raw-count excess (formatter-consumed syntax) from the newest runs
   * so their total matches how much the formatted text actually grew. See the
   * "raw vs formatted counts" invariant in the module header.
   */
  private reconcile(visible: number): void {
    const grown = this.lastVisible === null ? null : Math.max(0, visible - this.lastVisible);
    let excess = grown === null ? 0 : this.sinceApply - grown;
    this.lastVisible = visible;
    this.serial += this.sinceApply;
    this.sinceApply = 0;
    excess = Math.min(Math.max(0, excess), this.timeline.recorded - this.timeline.first);
    this.timeline.trimNewest(excess);
    this.serial -= excess;
  }

  /** `segmentAnsi(formatted)` plus its visible count, memoized on the string. */
  private segment(text: string): { segs: ReturnType<typeof segmentAnsi>; visible: number } {
    if (this.segCache?.text === text) return this.segCache;
    const segs = segmentAnsi(text);
    let visible = 0;
    for (const s of segs) if (s.kind === 'char' && !s.ws) visible++;
    this.segCache = { text, segs, visible };
    return this.segCache;
  }

  /** Birth time and style of the character `d` positions from the end (Infinity = unborn), or null if settled. */
  private birthOf(d: number): { birth: number; style: RevealStyle } | null {
    const i = this.timeline.recorded - 1 - d;
    if (this.timeline.isSettled(i)) return null;
    const birth = this.timeline.birthAt(i);
    const style = this.timeline.styleAt(i);
    return birth === null || style === undefined ? null : { birth, style };
  }

  /**
   * Advance the playhead to `t` and drop characters that have settled. A
   * smoke front's wisp can outlive its letter by `WISP_MS`, which is shorter
   * than any smoke letter's life, so pruning never strands a live wisp.
   */
  private prune(t: number): void {
    this.timeline.advance(t);
    this.timeline.prune(t, (style) => (style === 'ink' ? INK_MS : MAX_LIFETIME_MS));
  }
}

/** Re-exported for tests that inspect a burst's settle time. */
export { lifetimeOf };
