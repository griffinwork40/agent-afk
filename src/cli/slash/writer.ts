/**
 * Concrete Writer implementation backed by console + palette.
 *
 * The slash-command registry passes a Writer in its SlashContext so that
 * handlers print through a consistent interface and tests can swap in a
 * mock. This module provides the production implementation.
 *
 * ## Optional sink — routing through the compositor
 *
 * When `sink` is provided, every write flows through `sink.fn(line)`
 * instead of bare `console.log`/`process.stdout.write`. The sink is
 * read by reference on every write so a mutable holder — typically
 * the REPL's `CompletionWriter` (`cli/commands/interactive/shared.ts`) —
 * can be hot-swapped between `console.log` (default) and
 * `compositor.commitAbove` (while the compositor is armed) without
 * reconstructing the writer.
 *
 * No behavior change today: between-turn slash commands run when
 * `completionWriter.fn === console.log` anyway. The wiring exists so
 * Stage 3 (persistent compositor across turn boundaries) can route
 * slash output through `commitAbove` without further changes to this
 * module or to bootstrap.
 *
 * ### `raw()` semantics under a sink
 *
 * `raw()` always writes via `process.stdout.write` (no trailing
 * newline) unless the sink explicitly provides a `rawFn` method.
 * This preserves the no-trailing-newline contract regardless of
 * whether a sink is present. To intercept raw writes, set
 * `sink.rawFn`; omitting it leaves `raw()` routed to stdout directly.
 *
 * On a TTY (sinkless path), `raw()` applies the same
 * `boundLineToTerminal` guard as `line()` — each logical line is
 * bounded independently so wide content cannot auto-wrap to column 0.
 * Non-TTY output (piped) stays byte-identical. The sink path is NOT
 * bounded for the same reason `line()` skips it: the sink owner
 * (`CompletionWriter` / `compositor.commitAbove`) handles wrapping
 * and re-flows on resize.
 */

import { palette } from '../palette.js';
import { boundLineToTerminal } from '../render/bounded-line.js';
import type { Writer } from './types.js';

/**
 * Mutable sink shared with `CompletionWriter` in shared.ts via
 * structural typing. Defined here (the consumer side) so writer.ts
 * stays self-contained; CompletionWriter's matching shape is
 * intentional and load-bearing for Stage 3.
 *
 * `rawFn` is optional — provide it only when the sink needs to
 * intercept raw (no-newline) writes. When absent, `raw()` falls
 * through to `process.stdout.write` directly, preserving the
 * no-trailing-newline contract even when a sink is present.
 */
export interface WriterSink {
  fn: (line: string) => void;
  rawFn?: (text: string) => void;
}

export function createConsoleWriter(sink?: WriterSink): Writer {
  // Capture `sink` by reference inside the closures — each write reads
  // `sink.fn` fresh so REPL hot-swaps (between console.log and
  // compositor.commitAbove) take effect immediately, even on writers
  // that outlive a single turn (cf. bootstrap.ts's long-lived slashCtx.out).
  // Invariant: the sinkless path is a RAW write to the terminal, so it is
  // bounded here — slash tables are composed with fixed column widths
  // (`/worktree list` alone is ~100 columns) and would otherwise auto-wrap to
  // column 0 on a narrower terminal, detaching every continuation row from
  // its table. The sink path is deliberately NOT bounded: its owner
  // (`CompletionWriter` / `compositor.commitAbove`) already wraps at the live
  // width and re-wraps the retained band on resize, and pre-wrapping here
  // would freeze rows at today's width so a later widen could not rejoin them.
  const writeLine = sink !== undefined
    ? (text: string) => { sink.fn(text); }
    : (text: string) => { console.log(boundLineToTerminal(text)); };
  const writeRaw = (sink !== undefined && sink.rawFn !== undefined)
    ? (text: string) => { sink.rawFn!(text); }
    : (text: string) => {
        // Invariant: sinkless raw writes to a TTY must not exceed the terminal
        // width — wide content auto-wraps to column 0, detaching indents and
        // table columns from their rows. Apply the same boundLineToTerminal
        // guard used by `line()`. Each logical line (split on \n) is bounded
        // independently so embedded newlines are handled correctly.
        // Non-TTY (piped) output stays byte-identical.
        if (process.stdout.isTTY === true) {
          const bounded = text
            .split('\n')
            .map((l) => boundLineToTerminal(l))
            .join('\n');
          process.stdout.write(bounded);
        } else {
          process.stdout.write(text);
        }
      };
  return {
    line(text = ''): void { writeLine(text); },
    raw(text: string): void { writeRaw(text); },
    success(text: string): void { writeLine(palette.success('✓ ') + text); },
    info(text: string): void { writeLine(palette.info('ℹ ') + text); },
    warn(text: string): void { writeLine(palette.warning('⚠ ') + text); },
    error(text: string): void { writeLine(palette.error('✗ ') + text); },
  };
}
