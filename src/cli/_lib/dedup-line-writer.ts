/**
 * Defense-in-depth wrapper around a {@link Writer} that collapses runs of
 * consecutive identical lines.
 *
 * **Why this exists.** Even after the capture-mode spinner suppression and
 * thinking-mode downgrade (`_lib/capture-mode.ts`), a captured stream can
 * still receive identical lines from edge cases not yet anticipated
 * (sub-skill orchestration patterns, future emitter changes, recording
 * tools whose semantics drift). A consecutive-identical-line collapse
 * is the cheapest single layer of defense and has zero impact on the
 * live TTY path (capture-mode never wires this into the live writer).
 *
 * **Semantics.** Up to `maxRepeat` consecutive identical lines pass
 * through unchanged. The (maxRepeat + 1)-th and later identical lines
 * are dropped silently. When the run ends — either a different line
 * arrives or `flush()` is called — a single summary line of the form
 * `… (line repeated N more times)` is emitted to acknowledge the
 * suppression, so the user is not misled about output completeness.
 *
 * The wrapper preserves the underlying writer's other methods
 * (`raw` / `success` / `info` / `warn` / `error`) verbatim — only
 * `line` is dedup-aware. Those other methods are status-signal channels
 * and not subject to the same flood patterns.
 */

import type { Writer } from '../slash/types.js';

/**
 * Wrap a `Writer` so that consecutive identical `line()` calls beyond
 * `maxRepeat` are collapsed into a single trailing summary line.
 *
 * - `maxRepeat` defaults to 2. Setting it to 1 emits exactly one copy
 *   before suppression begins. Setting it to a large number effectively
 *   disables dedup (but you'd just not wrap in that case).
 * - The summary is only emitted when the run actually exceeded the cap.
 *   A run of 1 or 2 identical lines (at the default cap) emits nothing
 *   extra.
 * - `flush()` exists so callers can finalize the buffer at end-of-stream
 *   without waiting for a divergent line. Idempotent.
 */
export interface DedupingLineWriter extends Writer {
  /**
   * Emit a pending repeat-summary if the last run exceeded `maxRepeat`.
   * Idempotent and safe to call multiple times. Call once at end of
   * stream so a trailing run of duplicates is not silently swallowed.
   */
  flush(): void;
}

export function makeDedupingLineWriter(
  inner: Writer,
  maxRepeat = 2,
): DedupingLineWriter {
  if (maxRepeat < 1 || !Number.isInteger(maxRepeat)) {
    throw new RangeError(
      `makeDedupingLineWriter: maxRepeat must be a positive integer, got ${maxRepeat}`,
    );
  }

  let lastLine: string | null = null;
  let repeatCount = 0;

  const emitSummaryIfNeeded = (): void => {
    if (lastLine !== null && repeatCount > maxRepeat) {
      const suppressed = repeatCount - maxRepeat;
      inner.line(
        `  … (line repeated ${suppressed} more time${suppressed === 1 ? '' : 's'})`,
      );
    }
  };

  return {
    line(text?: string): void {
      // Normalize undefined → empty string so a blank line is comparable.
      // Constraint: `Writer.line(undefined)` is equivalent to `Writer.line('')`
      // in every existing implementation in this codebase. Treating them
      // differently here would mis-detect a run of blank lines.
      const t = text ?? '';
      if (t === lastLine) {
        repeatCount++;
        if (repeatCount <= maxRepeat) {
          inner.line(t);
        }
        // else: silently suppress; the summary will be emitted when the
        // run ends (different line arrives or flush() is called).
      } else {
        // Run boundary — flush the previous run's summary first, then
        // start the new run. Constraint: the summary MUST be emitted
        // before the new line so chronological order is preserved in
        // the rendered stream.
        emitSummaryIfNeeded();
        lastLine = t;
        repeatCount = 1;
        inner.line(t);
      }
    },
    raw(text: string): void {
      // `raw` is for ANSI / control-character writes. Dedup doesn't apply.
      // Reset the run state so a subsequent `line()` call starts a fresh
      // tally — otherwise an unrelated raw write between two identical
      // lines would be mis-collapsed across the gap.
      emitSummaryIfNeeded();
      lastLine = null;
      repeatCount = 0;
      inner.raw(text);
    },
    success(text: string): void {
      emitSummaryIfNeeded();
      lastLine = null;
      repeatCount = 0;
      inner.success(text);
    },
    info(text: string): void {
      emitSummaryIfNeeded();
      lastLine = null;
      repeatCount = 0;
      inner.info(text);
    },
    warn(text: string): void {
      emitSummaryIfNeeded();
      lastLine = null;
      repeatCount = 0;
      inner.warn(text);
    },
    error(text: string): void {
      emitSummaryIfNeeded();
      lastLine = null;
      repeatCount = 0;
      inner.error(text);
    },
    flush(): void {
      emitSummaryIfNeeded();
      lastLine = null;
      repeatCount = 0;
    },
  };
}
