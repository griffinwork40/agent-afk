/**
 * Result types passed between the phases of one anthropic-direct turn round.
 *
 * Contract: before the loop split, each of these outcomes was a `let` flag plus
 * a bare `return`/`continue` buried in a ~1000-line generator. Making them
 * values lets the phases live in separate modules while keeping the
 * orchestrator's control flow a readable switch — and lets the compiler check
 * that every outcome is handled.
 *
 * Invariant: any outcome named `terminated` means the producing phase ALREADY
 * yielded this turn's single terminal event. The orchestrator must `return`
 * without yielding anything further; emitting a second terminal would strand a
 * consumer that breaks on the first one.
 *
 * @module agent/providers/anthropic-direct/loop/outcomes
 */

import type { TurnResult } from '../types.js';

/** Which retry class a round is being re-driven under. */
export type RetryReason = 'ttfb' | 'overload' | 'stream-incomplete';

/**
 * What the connection + stream-consumption phase of one round produced.
 *
 * - `terminated` — a terminal event was already yielded; the turn is over.
 * - `retry` — re-drive this round; the retry handler owns backoff and signalling.
 * - `overload-exhausted` — mid-stream overload budget spent; route to the CLEAN
 *   overload terminal, never the fatal tail (#762).
 * - `translator-errored` — a real error event was yielded; finish the turn.
 * - `streamed` — the stream completed. `turnResult` is `null` when the stream
 *   ended without a digested result (e.g. a user interrupt broke out early),
 *   which the orchestrator maps to a single clean `turn.completed`.
 */
export type RoundOutcome =
  | { kind: 'terminated' }
  | { kind: 'retry'; reason: RetryReason }
  | { kind: 'overload-exhausted' }
  | { kind: 'translator-errored' }
  | { kind: 'streamed'; turnResult: TurnResult | null };

/**
 * What a retry handler decided after emitting its signalling and serving its
 * backoff. `terminated` means the turn was aborted DURING the backoff and the
 * terminal event has already been yielded.
 */
export type RetryOutcome = 'continue' | 'terminated';
