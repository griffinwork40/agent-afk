/**
 * Smoke-text reveal: streamed characters condense out of faint smoke
 * (speck, then haze, then a dim letter, then the real letter) instead of
 * popping in. Opt-in via `AFK_SMOKE_TEXT=1`.
 *
 * How it works:
 *  - `record(chunk)` runs when raw markdown arrives. Each burst of new
 *    characters gets staggered birth times, so a 40-character chunk appears
 *    as fast writing rather than a block. Births are monotonic, and a
 *    character is never revealed more than `MAX_LAG_MS` after it arrived.
 *  - `apply(formatted)` runs on the formatted pending overlay string just
 *    before it is painted. It walks the visible characters and styles the
 *    youngest ones by age.
 *
 * Invariant (age mapping by distance-from-end): ages are keyed by how far a
 * character sits from the END of the text, counting non-whitespace code
 * points only. New text always lands at the end, and a block commit only
 * removes text from the FRONT, so distance-from-end survives commits,
 * re-wrapping, indentation, and centering margins unchanged. Markdown syntax
 * that the formatter consumes (`**`, backticks) can shift the mapping by a
 * character or two near the tail, which is visually harmless.
 *
 * Invariant (settle driver): pending-overlay repaints are content-driven.
 * They fire on push() and resize, never on a periodic tick. Without a driver
 * of its own, the fade would freeze mid-smoke whenever the model paused.
 * While any character is still settling, `apply()` arms ONE timer that calls
 * the owner's existing throttled `scheduleRepaint()`. There is no second
 * paint path, and the timer stops as soon as everything has settled.
 *
 * Contract: this module never delays a block commit. Committed blocks render
 * through `formatBlockForCommit`, untouched by the mask. A paragraph's last
 * few characters may therefore snap solid a moment early. That is deliberate:
 * holding a tall overlay across `commitAbove()` can drop the block (see
 * `syncPendingOverlay` in markdown-stream.ts).
 *
 * @module cli/smoke-reveal
 */

import chalk from 'chalk';
import stringWidth from 'string-width';
import { env, isPlainOutputRequested } from '../config/env.js';
import { isExplicitlyEnabled } from '../config/env-helpers.js';
import { countVisible, segmentAnsi } from './smoke-reveal.ansi.js';
import { smokeTone } from './smoke-reveal.tones.js';

/** Total time from first speck to fully settled letter. */
export const LIFETIME_MS = 320;
/** Fraction of the lifetime spent as a smoke glyph before the letter shows. */
export const GLYPH_PHASE = 0.36;
/** Spacing between characters revealed from one burst. */
export const STAGGER_MS = 6;
/** Upper bound on how far a reveal may trail the character's arrival. */
export const MAX_LAG_MS = 160;
/** Settle-driver cadence, which matches the renderer's default throttle. */
export const FRAME_MS = 33;
/**
 * Smoke glyph ladder, faintest first: a lone braille speck, then braille
 * particles that grow denser. Chosen by rendering candidate ladders side by
 * side. Shade blocks (░▒) read as redaction bars, and plain dots read as a
 * loading ellipsis.
 *
 * Invariant: every glyph must be East-Asian-Width NEUTRAL/narrow, never
 * Ambiguous. An Ambiguous glyph (e.g. U+00B7 `·`) renders 2 columns on
 * terminals set to "ambiguous characters are double-width" (common in CJK
 * locales), which breaks the column-width invariant and can wrap a
 * full-width line mid-fade. Braille patterns are always 1 column.
 */
export const SMOKE_GLYPHS: readonly string[] = ['⠁', '⠂', '⠢', '⠶'];

/** SGR reset. Clears the tail's original styling before a smoke glyph. */
const RESET = '\u001b[0m';

interface Burst {
  start: number;
  end: number;
  count: number;
}

/**
 * Whether the smoke effect should run in this process: `AFK_SMOKE_TEXT` is
 * explicitly enabled, plain-output mode is off, and chalk can render at
 * least 256 colors. The last check also disables it for NO_COLOR, CI, and
 * non-TTY, since `configureColor()` drops chalk.level to 0 there.
 */
export function isSmokeTextEnabled(): boolean {
  const raw = env.AFK_SMOKE_TEXT;
  if (!raw || !isExplicitlyEnabled(raw)) return false;
  if (isPlainOutputRequested()) return false;
  return chalk.level >= 2;
}

/** Render one character at `age` ms old. Assumes 0 <= age < LIFETIME_MS. */
function renderAt(ch: string, age: number): string {
  const f = age / LIFETIME_MS;
  // Smoke phase: particles densify and brighten from 0.12 to 0.4 of the ramp.
  // Wide glyphs (CJK, emoji) keep their own character so the column count
  // never changes. Only narrow characters swap to a smoke glyph.
  if (f < GLYPH_PHASE && stringWidth(ch) === 1) {
    const p = f / GLYPH_PHASE;
    const g = Math.min(SMOKE_GLYPHS.length - 1, Math.floor(p * SMOKE_GLYPHS.length));
    return RESET + smokeTone(0.12 + 0.28 * p)(SMOKE_GLYPHS[g] ?? '⠁');
  }
  // Letter phase: the real character fades up from dim to the settled tone,
  // after which apply() stops styling it and its own markdown styling returns.
  const p = f < GLYPH_PHASE ? 0 : (f - GLYPH_PHASE) / (1 - GLYPH_PHASE);
  return RESET + smokeTone(0.4 + 0.6 * p)(ch);
}

export class SmokeReveal {
  private bursts: Burst[] = [];
  private nextBirth = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly requestRepaint: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Register newly arrived raw text. Whitespace-only chunks are ignored. */
  record(chunk: string): void {
    const count = countVisible(chunk);
    if (count === 0) return;
    const t = this.now();
    const cap = t + MAX_LAG_MS;
    const start = Math.min(Math.max(t, this.nextBirth), cap);
    const end = Math.min(start + (count - 1) * STAGGER_MS, cap);
    this.bursts.push({ start, end, count });
    this.nextBirth = end + STAGGER_MS;
    this.prune(t);
  }

  /**
   * Style the youngest characters of `formatted` by age. Returns `formatted`
   * unchanged (same reference) when nothing is animating.
   */
  apply(formatted: string): string {
    const t = this.now();
    this.prune(t);
    if (this.bursts.length === 0 || formatted === '') return formatted;

    const segs = segmentAnsi(formatted);
    let visible = 0;
    for (const s of segs) if (s.kind === 'char' && !s.ws) visible++;

    // Characters at or beyond the recorded total are settled by definition,
    // so skip the per-burst walk for them (most of a long paragraph).
    const recorded = this.recordedCount();
    let idx = 0;
    let animating = false;
    let out = '';
    for (const s of segs) {
      if (s.kind === 'raw' || s.ws) {
        out += s.text;
        continue;
      }
      const d = visible - 1 - idx;
      const birth = d >= recorded ? null : this.birthOf(d);
      idx++;
      if (birth === null || t - birth >= LIFETIME_MS) {
        out += s.text;
        continue;
      }
      animating = true;
      const age = t - birth;
      // Not revealed yet: hold the cell blank so layout never shifts.
      out += age < 0 ? ' '.repeat(Math.max(1, stringWidth(s.text))) : renderAt(s.text, age);
    }
    if (animating) this.armTick();
    return animating ? out + RESET : formatted;
  }

  /** Forget all history (e.g. the pending buffer was discarded). */
  reset(): void {
    this.bursts = [];
    this.nextBirth = 0;
    this.clearTick();
  }

  /** Stop the settle driver. Safe to call repeatedly. */
  dispose(): void {
    this.reset();
  }

  /** Total characters across live (not yet pruned) bursts. */
  private recordedCount(): number {
    let n = 0;
    for (const b of this.bursts) n += b.count;
    return n;
  }

  /** Birth time of the character `d` positions from the end, or null if settled. */
  private birthOf(d: number): number | null {
    let rem = d;
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      if (!b) continue;
      if (rem < b.count) {
        if (b.count === 1) return b.start;
        const j = b.count - 1 - rem;
        return b.start + ((b.end - b.start) * j) / (b.count - 1);
      }
      rem -= b.count;
    }
    return null;
  }

  /** Drop bursts whose every character has settled. They are oldest-first. */
  private prune(t: number): void {
    while (this.bursts.length > 0 && (this.bursts[0]?.end ?? 0) + LIFETIME_MS <= t) {
      this.bursts.shift();
    }
  }

  private armTick(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.requestRepaint();
    }, FRAME_MS);
    this.timer.unref?.();
  }

  private clearTick(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
