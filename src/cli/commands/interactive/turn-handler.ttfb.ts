import type { OutputEvent } from '../../../agent/types.js';
import { isPlainOutputRequested } from '../../../config/env.js';
import { palette } from '../../palette.js';
import type { CompletionWriter } from './shared.js';
import { PlainTurnHooks } from './turn-handler.plain-hooks.js';

/** Turn-level TTFB state that intentionally survives renderer resume rebuilds. */
export interface TurnTtfbState {
  readonly startedAt: number;
  received: boolean;
  /**
   * Whether the TTFB waiting line was emitted in TTY+plain mode.
   * When true, the first-content hook must erase it before writing tokens.
   */
  waitingLineEmitted: boolean;
  /**
   * Plain-mode progress hooks. Present when plain output is active and
   * stdout is a TTY — created by {@link emitPlainTtfbWaiting} and consumed
   * by turn-handler.ts at tool/subagent event sites via `state.plainHooks`.
   */
  plainHooks?: PlainTurnHooks;
}

export function createTurnTtfbState(startedAt: number): TurnTtfbState {
  return { startedAt, received: false, waitingLineEmitted: false };
}

/**
 * Supply the timer only until content has been seen. A paused→resumed replay
 * gets a replacement renderer, but must not restart TTFB after content was
 * already visible before the quota pause.
 */
export function ttfbRendererOptions(state: TurnTtfbState): { turnStartedAt?: number } {
  return state.received ? {} : { turnStartedAt: state.startedAt };
}

/** Latch the first content event while preserving the replay-local stream flag. */
export function observeFirstContent(
  state: TurnTtfbState,
  event: OutputEvent,
  streamingStarted: boolean,
): boolean {
  const first = event.type === 'chunk' && event.chunk.type === 'content' && !streamingStarted;
  if (first) state.received = true;
  return first;
}

/**
 * Plain-output mode has no live overlay, so handle the "waiting for response"
 * line per stdout type:
 *
 * - Non-TTY (piped): suppress the line entirely — escape codes in a pipe are
 *   junk and a lingering status line is noise in a log/file capture.
 * - TTY + plain-output requested: emit a static dim line, then erase it before
 *   the first token via the hooks' `onFirstContent` method. The erase uses
 *   `\r\x1b[2K` (carriage return + Erase Line), which is safe on a real TTY
 *   and keeps scrollback clean (the line vanishes rather than accumulating).
 *
 * Also creates and attaches the plain-mode progress hooks to `state.plainHooks`
 * when in TTY+plain mode, so turn-handler.ts can wire per-event callbacks
 * without a separate construction call.
 */
export function emitPlainTtfbWaiting(
  completionWriter: CompletionWriter | undefined,
  stdout: NodeJS.WriteStream = process.stdout,
  state?: TurnTtfbState,
): void {
  if (!isPlainOutputRequested()) return;
  // Non-TTY (piped/CI): suppress the line entirely.
  if (!stdout.isTTY) return;
  // TTY + plain: emit a static line that we will erase on first token.
  const fn = completionWriter?.fn ?? console.log;
  fn(palette.dim('   ◦ waiting for response…'));
  if (state) {
    state.waitingLineEmitted = true;
    if (completionWriter) state.plainHooks = new PlainTurnHooks(completionWriter, state);
  }
}

/**
 * Erase the TTFB waiting line before the first response token arrives,
 * keeping scrollback clean on TTY+plain sessions.
 *
 * Must be called exactly once per turn when `isFirstContentEvent` is true
 * (via `state.plainHooks?.onFirstContent(stdout)` — the hooks object owns
 * this call in turn-handler.ts). No-op when the waiting line was never
 * emitted (non-TTY, non-plain, or already received).
 */
export function eraseWaitingLineIfNeeded(
  state: TurnTtfbState,
  stdout: NodeJS.WriteStream = process.stdout,
): void {
  if (!state.waitingLineEmitted) return;
  state.waitingLineEmitted = false;
  // `\r\x1b[2K` = carriage return + CSI Erase Line: overwrites the current
  // line with blanks, leaving the cursor at column 0 for the next write.
  // Safe on a real TTY; no-op equivalent if isTTY was wrong.
  stdout.write('\r\x1b[2K');
}
