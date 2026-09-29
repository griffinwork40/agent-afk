/**
 * Word reveal (`AFK_WORD_TEXT=1`): streamed prose appears a whole word at a
 * time, at a steady cadence, and only the newest words fade briefly from dim
 * into their own color. Built for a reader who reads along live: the smoke
 * and ink reveals animate a per-character front at 60-180 cps, a stream of
 * abrupt onsets right next to the words being read. Research and ranking:
 * docs/reveal-read-along-research.md (option 2).
 *
 * How it works:
 *  - `record(chunk)` counts the raw visible characters and remembers whether
 *    the raw stream currently ends INSIDE a word (no trailing whitespace).
 *  - `apply(formatted)` finds the word ends in the formatted overlay. At most
 *    once per `WORD_TICK_MS` it releases the oldest waiting whole words as one
 *    cohort: `ceil(waiting / WORD_DRAIN_TICKS)` of them, so a network burst
 *    drains in a few calm steps and the backlog self-balances at a lag of
 *    about `WORD_DRAIN_TICKS * WORD_TICK_MS`. Unreleased characters are drawn
 *    as blank cells of the same width; a released cohort fades over
 *    `WORD_FADE_MS`, and older text is drawn untouched.
 *  - A trailing partial word is never shown while it is still growing. It is
 *    released once whitespace follows it, or once the stream has been quiet
 *    for `PARTIAL_WORD_WAIT_MS` (a pause before a tool call, the last word of
 *    an answer).
 *
 * Invariant (pace the REVEAL, never the TEXT): as in smoke-reveal.ts, every
 * character is in the buffer and laid out exactly as with the reveal off.
 * Only blank-until-released and the short fade differ, so layout, wrapping
 * and commits are byte-identical to reveal-off.
 *
 * Invariant (identity by distance from the end): the character `d` positions
 * from the end of the tracked text has id `serial - 1 - d`. New text lands at
 * the end and commits only remove text from the front, so ids survive commits
 * and re-wraps. Everything with id < `shownUpTo` is released. Raw-vs-formatted
 * count drift (syntax the formatter consumes) is reconciled per apply the same
 * way smoke-reveal.ts does, and additionally when the formatted count SHRINKS
 * (an earlier literal `*` became syntax), so a consumed marker never pushes a
 * shown letter back into the hidden range.
 *
 * Contract: implements the `TextReveal` seam (text-reveal.ts) that
 * markdown-stream.ts drives. It never holds a heading (`smokeHoldRemaining`
 * is always 0), and `revealHoldRemaining` lets commit-defer keep a finished
 * paragraph in the overlay until its last word is released and mostly faded.
 *
 * @module cli/word-reveal
 */

import chalk from 'chalk';
import stringWidth from 'string-width';
import { env, isPlainOutputRequested } from '../config/env.js';
import { isExplicitlyEnabled } from '../config/env-helpers.js';
import { segmentAnsi, countVisible } from './smoke-reveal.ansi.js';
import { FrameClock } from './markdown-stream.frame-clock.js';
import { fadeCell } from './smoke-reveal.cells.js';
import { applySgr, EMPTY_SGR, isSgr, type SgrState } from './smoke-reveal.sgr.js';

/** Minimum spacing between word releases (20 Hz). */
export const WORD_TICK_MS = 50;
/** A backlog of N whole words drains over about this many ticks. */
export const WORD_DRAIN_TICKS = 3;
/** Fade of a released cohort, dim to its own color. */
export const WORD_FADE_MS = 150;
/** Ramp position a released word starts from (0 = background, 1 = full). */
export const WORD_FADE_FLOOR = 0.35;
/** Quiet time after which a trailing partial word is shown anyway. */
export const PARTIAL_WORD_WAIT_MS = 250;
/** Share of the fade a deferred paragraph commit waits for. */
export const WORD_HOLD_SHARE = 0.75;
/** Re-check interval while the asked-about character is not released yet. */
const RECHECK_MS = 32;
const RESET = '\u001b[0m';

/** Released ids `[from, to)` and when they were released. */
interface Cohort {
  from: number;
  to: number;
  birth: number;
}

type Segs = ReturnType<typeof segmentAnsi>;

/** A word's first and last letter ids; `tail` = the text's final word. */
interface Word {
  start: number;
  end: number;
  tail: boolean;
}

/** Word reveal opt-in: `AFK_WORD_TEXT` explicitly enabled on a 256+ color, non-plain terminal. */
export function isWordTextEnabled(): boolean {
  const raw = env.AFK_WORD_TEXT;
  if (!raw || !isExplicitlyEnabled(raw)) return false;
  return !isPlainOutputRequested() && chalk.level >= 2;
}

export class WordReveal {
  private readonly clock: FrameClock;
  /** Reconciled visible characters tracked over this instance's life. */
  private serial = 0;
  /** Raw visible characters recorded since the last walked apply(). */
  private sinceApply = 0;
  /** Visible count at the last walked apply(); null = no valid baseline. */
  private lastVisible: number | null = null;
  /** Every id below this is released. */
  private shownUpTo = 0;
  /** Cohorts still fading, oldest first. */
  private cohorts: Cohort[] = [];
  private lastReleaseAt = -Infinity;
  private lastRecordAt = -Infinity;
  /** The raw stream currently ends inside a word. */
  private tailOpen = false;
  private segCache: { text: string; segs: Segs; visible: number } | null = null;

  /** `paint` must paint immediately (unthrottled): the frame clock already paces it. */
  constructor(paint: () => void, private readonly now: () => number = Date.now) {
    this.clock = new FrameClock(paint);
  }

  /** Register newly arrived raw text. Options are accepted for seam compatibility and ignored. */
  record(chunk: string, _opts?: unknown): void {
    if (chunk === '') return;
    this.tailOpen = !/\s$/u.test(chunk);
    this.lastRecordAt = this.now();
    this.sinceApply += countVisible(chunk);
  }

  /** The word reveal never holds a heading. */
  smokeHoldRemaining(): number {
    return 0;
  }

  /**
   * Milliseconds until the character `d` positions from the end (0 = newest)
   * is released and `WORD_HOLD_SHARE` through its fade. `RECHECK_MS` while it
   * is still waiting to be released; 0 when shown or untracked.
   */
  revealHoldRemaining(d = 0): number {
    const id = this.serial + this.sinceApply - 1 - d;
    if (id < 0) return 0;
    if (id >= this.shownUpTo) return RECHECK_MS;
    const c = this.cohortOf(id);
    return c ? Math.max(0, c.birth + WORD_FADE_MS * WORD_HOLD_SHARE - this.now()) : 0;
  }

  /**
   * Blank the unreleased newest words and fade the newest released ones.
   * Returns `formatted` unchanged (same reference) when nothing is animating.
   */
  apply(formatted: string, _opts?: unknown): string {
    const t = this.now();
    this.cohorts = this.cohorts.filter((c) => t - c.birth < WORD_FADE_MS);
    if (formatted === '') return formatted;
    if (this.sinceApply === 0 && this.shownUpTo >= this.serial && this.cohorts.length === 0) return formatted;
    const { segs, visible } = this.segment(formatted);
    this.reconcile(visible);
    this.release(this.unreleasedWords(segs, visible), t);
    return this.render(formatted, segs, visible, t);
  }

  /** True while the frame clock is driving repaints (a word is waiting or fading). */
  get animating(): boolean {
    return this.clock.running;
  }

  /** Ask the frame clock for a paint on its next tick. */
  markDirty(): void {
    this.clock.markDirty();
  }

  /** Text just left the FRONT of the overlay (a block commit). */
  noteCommit(): void {
    this.lastVisible = null;
  }

  /** Forget the `count` newest characters (a stripped pending tail). */
  forgetNewest(count: number): void {
    const fromSince = Math.min(Math.max(0, count), this.sinceApply);
    this.sinceApply -= fromSince;
    this.serial -= Math.min(count - fromSince, this.serial);
    this.shownUpTo = Math.min(this.shownUpTo, this.serial);
    this.cohorts = this.cohorts.filter((c) => c.from < this.serial);
    this.lastVisible = null;
    this.tailOpen = false;
  }

  /** Forget all history (e.g. the pending buffer was discarded). */
  reset(): void {
    this.serial = 0;
    this.sinceApply = 0;
    this.lastVisible = null;
    this.shownUpTo = 0;
    this.cohorts = [];
    this.lastReleaseAt = -Infinity;
    this.tailOpen = false;
    this.segCache = null;
    this.clock.stop();
  }

  /** Stop the settle driver and clear all history. Safe to call repeatedly. */
  dispose(): void {
    this.reset();
  }

  /**
   * Fold raw characters recorded since the last walk into `serial`, minus the
   * syntax the formatter consumed. A shrink (an earlier literal became syntax)
   * trims tracked characters too. See the identity invariant in the header.
   */
  private reconcile(visible: number): void {
    const delta = this.lastVisible === null ? this.sinceApply : visible - this.lastVisible;
    const excess = Math.min(Math.max(0, this.sinceApply - delta), this.sinceApply + this.serial);
    this.serial += this.sinceApply - excess;
    this.sinceApply = 0;
    this.lastVisible = visible;
    this.shownUpTo = Math.min(this.shownUpTo, this.serial);
  }

  /**
   * Words not yet fully released, oldest first, as `[start, end]` ids. The
   * first may straddle `shownUpTo` (see `release`). `tail` marks the text's
   * final word.
   */
  private unreleasedWords(segs: Segs, visible: number): Word[] {
    const words: Word[] = [];
    let idx = 0;
    let start: number | null = null;
    const close = (endId: number): void => {
      if (start !== null && endId >= this.shownUpTo) words.push({ start, end: endId, tail: false });
      start = null;
    };
    for (const s of segs) {
      if (s.kind === 'raw') continue;
      const id = this.serial - visible + idx;
      if (s.ws) {
        close(id - 1);
        continue;
      }
      if (start === null) start = id;
      idx++;
    }
    close(this.serial - 1);
    const last = words.at(-1);
    if (last && last.end === this.serial - 1) last.tail = true;
    return words;
  }

  /**
   * Release the oldest waiting words as one cohort, at most once per tick. A
   * word straddling `shownUpTo` (a consumed syntax marker shifted the ids, or
   * a word shown after a pause kept growing) is completed immediately, so a
   * half word is never left on screen. The final word waits while the raw
   * stream is still inside it.
   */
  private release(words: Word[], t: number): void {
    const first = words[0];
    if (first && first.start < this.shownUpTo) {
      this.cohorts.push({ from: this.shownUpTo, to: first.end + 1, birth: t });
      this.shownUpTo = first.end + 1;
      words.shift();
    }
    const tailHeld = this.tailOpen && t - this.lastRecordAt < PARTIAL_WORD_WAIT_MS;
    if (tailHeld && words.at(-1)?.tail) words.pop();
    if (words.length === 0 || t - this.lastReleaseAt < WORD_TICK_MS) return;
    const last = words[Math.max(1, Math.ceil(words.length / WORD_DRAIN_TICKS)) - 1];
    if (last === undefined) return;
    this.cohorts.push({ from: this.shownUpTo, to: last.end + 1, birth: t });
    this.shownUpTo = last.end + 1;
    this.lastReleaseAt = t;
  }

  /** Draw unreleased letters as blanks and fading letters dimmed; everything else verbatim. */
  private render(formatted: string, segs: Segs, visible: number, t: number): string {
    const parts: string[] = [];
    let state: SgrState = EMPTY_SGR;
    let idx = 0;
    let animating = false;
    for (const s of segs) {
      if (s.kind === 'raw') {
        if (isSgr(s.text)) state = applySgr(state, s.text);
        parts.push(s.text);
        continue;
      }
      if (s.ws) {
        parts.push(s.text);
        continue;
      }
      const id = this.serial - visible + idx;
      idx++;
      if (id >= this.shownUpTo) {
        parts.push(' '.repeat(Math.max(1, stringWidth(s.text))));
        animating = true;
        continue;
      }
      const c = id >= 0 ? this.cohortOf(id) : null;
      const age = c ? t - c.birth : Infinity;
      if (age < WORD_FADE_MS) {
        parts.push(fadeCell(s.text, age / WORD_FADE_MS, state, WORD_FADE_FLOOR));
        animating = true;
      } else parts.push(s.text);
    }
    if (!animating) return formatted;
    this.clock.markDirty();
    return parts.join('') + RESET;
  }

  private cohortOf(id: number): Cohort | null {
    for (const c of this.cohorts) if (id >= c.from && id < c.to) return c;
    return null;
  }

  /** `segmentAnsi(formatted)` plus its visible count, memoized on the string. */
  private segment(text: string): { segs: Segs; visible: number } {
    if (this.segCache?.text === text) return this.segCache;
    const segs = segmentAnsi(text);
    let visible = 0;
    for (const s of segs) if (s.kind === 'char' && !s.ws) visible++;
    this.segCache = { text, segs, visible };
    return this.segCache;
  }
}
