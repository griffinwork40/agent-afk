/**
 * ReplRenderer — output routing seam for the interactive REPL.
 *
 * When a TerminalCompositor is armed (mid-turn), writes route through
 * compositor.commitAbove() so they enter scrollback above the live region
 * without tearing the log-update frame. When the compositor is disarmed
 * (between turns) or absent, writes go directly to stdout — but routed
 * through statusLine.withFullScrollRegion() so the `\n` doesn't get
 * clipped by the StatusLine's DECSTBM sub-region scroll (which on
 * xterm-derived terminals silently discards lines that exit the top of
 * the active region).
 *
 * Non-TTY surfaces (pipes, CI) get a simple stdout-only variant. The same
 * plain variant is also selected on a TTY when `AFK_PLAIN_OUTPUT` is truthy
 * — a full render opt-out for tmux/SSH/multiplexer sessions where the live
 * overlay's cursor-up redraws and DECSTBM reserved rows misbehave. This is
 * one of three sites gated on {@link isPlainOutputRequested}: this seam
 * (between-turn writes), `InputSurface.armCompositor` (the persistent
 * compositor), and `StreamRenderer`'s `isTTY` computation (the per-turn
 * overlay) — all three must agree for the TTY session to fully behave like
 * non-TTY. Default TTY behavior (the live overlay) is unchanged unless this
 * var is set.
 *
 * The compositor is bound lazily via setCompositor() — mirrors the
 * CompletionWriter pattern already used in shared.ts / turn-handler.ts.
 */

import { isPlainOutputRequested } from '../../../config/env.js';
import { boundLineToTerminal } from '../../render/bounded-line.js';

interface CompositorRef {
  isArmed(): boolean;
  commitAbove(text: string): void;
}

/**
 * Minimal structural type for the DECSTBM guard supplied by StatusLine.
 * Decouples ReplRenderer from the concrete StatusLine class and matches
 * the same pattern used in src/cli/input/types.ts for setExtraRows.
 */
export interface ScrollRegionGuard {
  withFullScrollRegion<T>(fn: () => T): T;
}

export interface ReplRenderer {
  writeLine(text: string): void;
  setCompositor(c: CompositorRef | null): void;
}

export interface CreateReplRendererOpts {
  /**
   * When provided, raw stdout writes are wrapped in
   * `statusLine.withFullScrollRegion(...)` so they aren't clipped by the
   * StatusLine's DECSTBM sub-region. Optional — when absent the fallback
   * writes plain stdout (legacy behavior, may lose lines from scrollback
   * if a status line is active elsewhere).
   */
  statusLine?: ScrollRegionGuard;
}

export function createReplRenderer(
  stdout: NodeJS.WriteStream,
  opts: CreateReplRendererOpts = {},
): ReplRenderer {
  // Plain/append-only path: non-TTY surfaces (pipes, CI) always take it;
  // AFK_PLAIN_OUTPUT lets a real TTY opt into the same path (reliability
  // escape hatch — see module doc above). Strictly additive: this OR only
  // ever widens which sessions get the plain path, never narrows it.
  if (!stdout.isTTY || isPlainOutputRequested()) {
    return {
      writeLine: (text) => {
        stdout.write(text + '\n');
      },
      setCompositor: () => {
        // no-op on the plain path — there is no live overlay to bind to.
      },
    };
  }

  let compositor: CompositorRef | null = null;
  const guard = opts.statusLine;

  return {
    writeLine(text) {
      if (compositor?.isArmed()) {
        compositor.commitAbove(text);
        return;
      }
      // Between turns. The StatusLine's DECSTBM scroll region is active
      // for the lifetime of the REPL, so a raw `\n` written at the bottom
      // of the active sub-region triggers a sub-region scroll on
      // xterm/iTerm2/Apple Terminal — and the displaced top line does not
      // enter the terminal's scrollback buffer. Route through the guard
      // so the write happens with full-screen scroll semantics instead.
      //
      // Invariant: this is the disarmed path, i.e. a RAW write with no
      // compositor to wrap it — bound it here so an over-wide row is wrapped
      // with its indent hanging rather than auto-wrapped by the terminal to
      // column 0. The armed path above needs no bounding: commitAbove wraps
      // at the live width and reflows the retained band on resize.
      const bounded = boundLineToTerminal(text, stdout);
      if (guard) {
        guard.withFullScrollRegion(() => {
          stdout.write(bounded + '\n');
        });
      } else {
        stdout.write(bounded + '\n');
      }
    },
    setCompositor(c) {
      compositor = c;
    },
  };
}
