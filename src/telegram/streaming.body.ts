/**
 * Final-body composition for the Telegram streaming handler
 *
 * `computeFinalBody` is the module-level replacement for the inner closure
 * `finalBody()` in `streamResponse`. Taking explicit state parameters instead
 * of closing over the outer scope makes the computation testable in isolation
 * and localizes the "what goes in the final delivered message" contract.
 * Extracted from streaming.ts — the public surface of streaming.ts is unchanged.
 * @module telegram/streaming.body
 */

import { renderProgressRegion } from './streaming.preview.js';
import type { ProgressEntry } from './streaming.preview.js';

/**
 * State slice consumed by `computeFinalBody`. Extracted here rather than
 * inlined so `streamResponse` can pass explicit arguments instead of closing
 * over its outer scope.
 */
export interface FinalBodyState {
  readonly accumulated: string;
  readonly progressEntries: readonly ProgressEntry[];
}

/**
 * Compose the FINAL delivery body from accumulated content and the bounded
 * tool-progress region.
 *
 * Invariant: the latency gate throttles LIVE churn only — once the turn is
 * over there is nothing left to churn, so a finished turn always surfaces the
 * progress it recorded instead of silently dropping lines the gate happened to
 * withhold. Every terminal/fallback delivery path uses this; `accumulated`
 * alone would be empty on a gated progress-only turn and would strand the user
 * on the bare `Thinking…` placeholder.
 *
 * Invariant: keeps the LEGACY trailing-footer shape. This function is not
 * preview-only — it is the text actually delivered when `answerText` is empty
 * (progress-only turn) or when the stream ends without a terminal event, so its
 * bytes are held stable and the interleave is confined to `computeLivePreview`.
 *
 * Module-level replacement for the former inner closure `finalBody()` in
 * `streamResponse`. Takes explicit state to avoid closing over mutable outer
 * variables.
 */
export function computeFinalBody(state: FinalBodyState): string {
  return state.accumulated + renderProgressRegion(state.progressEntries.map((e) => e.label));
}
