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
 */

import { palette } from '../palette.js';
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
  const writeLine = sink !== undefined
    ? (text: string) => { sink.fn(text); }
    : (text: string) => { console.log(text); };
  const writeRaw = (sink !== undefined && sink.rawFn !== undefined)
    ? (text: string) => { sink.rawFn!(text); }
    : (text: string) => { process.stdout.write(text); };
  return {
    line(text = ''): void { writeLine(text); },
    raw(text: string): void { writeRaw(text); },
    success(text: string): void { writeLine(palette.success('✓ ') + text); },
    info(text: string): void { writeLine(palette.info('ℹ ') + text); },
    warn(text: string): void { writeLine(palette.warning('⚠ ') + text); },
    error(text: string): void { writeLine(palette.error('✗ ') + text); },
  };
}
