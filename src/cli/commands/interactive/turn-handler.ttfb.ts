import type { OutputEvent } from '../../../agent/types.js';
import { isPlainOutputRequested } from '../../../config/env.js';
import { palette } from '../../palette.js';
import type { CompletionWriter } from './shared.js';

/** Turn-level TTFB state that intentionally survives renderer resume rebuilds. */
export interface TurnTtfbState {
  readonly startedAt: number;
  received: boolean;
}

export function createTurnTtfbState(startedAt: number): TurnTtfbState {
  return { startedAt, received: false };
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
 * Plain-output mode has no live overlay, so emit one static waiting line at
 * submission. It is deliberately not updated: erasing it would violate the
 * AFK_PLAIN_OUTPUT plain-text contract.
 */
export function emitPlainTtfbWaiting(completionWriter: CompletionWriter | undefined): void {
  if (isPlainOutputRequested()) {
    (completionWriter ?? { fn: console.log }).fn(palette.dim('  ◦ waiting for response…'));
  }
}
