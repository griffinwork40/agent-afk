/**
 * Per-attempt timeout handle pair for {@link driveStream}.
 *
 * Extracted from stream-drive.ts to keep that file under 350 LOC. Arms a
 * first-byte (TTFB) guard chained to the turn signal, then a stall guard
 * chained to the TTFB signal — matching the anthropic-direct wiring.
 *
 * @module agent/providers/openai-compatible/query/stream-timeouts
 */

import {
  armFirstByteTimeout,
  type FirstByteTimeoutHandle,
} from '../../shared/first-byte-timeout.js';
import {
  armStreamStallWatchdog,
  type StreamStallHandle,
} from '../../shared/stream-stall-timeout.js';

export interface StreamAttemptTimeouts {
  ttfb: FirstByteTimeoutHandle;
  stall: StreamStallHandle;
  /** The signal to pass to createStream and abortableStream. */
  signal: AbortSignal;
  /** Dispose both handles. Idempotent; safe to call in a finally block. */
  dispose(): void;
}

/**
 * Arm both timeout guards for one stream attempt.
 *
 * Chain: turn signal → TTFB controller → stall controller. An abort on any
 * outer link propagates inward so the HTTP stream is always released.
 */
export function armAttemptTimeouts(
  turnSignal: AbortSignal,
  ttfbMs: number,
  stallMs: number,
): StreamAttemptTimeouts {
  const ttfb = armFirstByteTimeout(turnSignal, ttfbMs);
  const stall = armStreamStallWatchdog(ttfb.signal, stallMs);
  return {
    ttfb,
    stall,
    signal: stall.signal,
    dispose(): void {
      stall.dispose();
      ttfb.dispose();
    },
  };
}
