/**
 * Visible-plan-text tracker for the `exit_plan_mode` gate.
 *
 * Tracks how much VISIBLE assistant prose the model has streamed in its
 * current response (model round), so the `exit_plan_mode` handler can refuse
 * to show the "Plan ready. (Your plan is in the conversation above.)" picker
 * when the plan was never written where the user can see it. Tool results and
 * thinking are collapsed or hidden in the REPL, so they do not count.
 *
 * Why: a model finished `/devils-advocate` in plan mode and called
 * `exit_plan_mode` with zero visible text; the user approved a plan they never
 * saw. See the PR that introduced this module for the full trace.
 *
 * @module agent/session/plan-text-tracker
 */

import type { ProviderEvent } from '../provider.js';

/**
 * Minimum non-whitespace characters of visible prose in the current response
 * for `exit_plan_mode` to show the picker. Long enough that a filler preamble
 * ("OK, let me finalize the plan.") does not count; far below any real plan.
 */
export const MIN_PLAN_TEXT_CHARS = 80;

/**
 * Refusals per user turn before the gate stops refusing and instead shows the
 * picker with an explicit warning. Bounds the loop when a model keeps calling
 * the tool without writing text; the user is never stranded without a picker.
 */
export const MAX_PLAN_TEXT_REFUSALS = 2;

/**
 * Gate verdict for one `exit_plan_mode` call:
 * - `ok`     — enough visible text this response; show the normal picker.
 * - `refuse` — not enough; tell the model to write the plan and call again.
 * - `warn`   — refusal budget spent; show the picker with a warning.
 */
export type PlanTextVerdict = 'ok' | 'refuse' | 'warn';

// Invariant: round scoping without a round-start event. Provider streams have
// no explicit "new assistant message" event, so a round boundary is inferred:
// a `tool.output` marks the previous round's tools as resolved and ARMS a
// reset, which the next content-bearing event (`delta.text`, `tool.use.start`,
// `tool.use`) APPLIES. Deferring matters for parallel tool batches: a sibling
// tool's `tool.output` in the same batch as `exit_plan_mode` may be observed
// before the exit handler runs, and must not zero the text the model wrote in
// that same response. A response carrying only a tool call applies the armed
// reset on its `tool.use.start`, so it correctly reads as "no visible text".
//
// Ordering: provider generators are pull-based (`for await` / `yield*`), so
// every `delta.text` of a response is consumed by the turn runner (which calls
// `observe`) before the provider advances to tool dispatch, where the
// `exit_plan_mode` handler calls `check`.
export class PlanTextTracker {
  private roundChars = 0;
  private resetArmed = false;
  private refusals = 0;

  /** Reset all state at the start of a user turn. */
  beginTurn(): void {
    this.roundChars = 0;
    this.resetArmed = false;
    this.refusals = 0;
  }

  /** Observe one provider event, in stream order. */
  observe(event: ProviderEvent): void {
    switch (event.type) {
      case 'delta.text':
        this.applyArmedReset();
        this.roundChars += countVisible(event.text);
        return;
      case 'tool.use.start':
      case 'tool.use':
        this.applyArmedReset();
        return;
      case 'tool.output':
        this.resetArmed = true;
        return;
      case 'stream.retry':
        // The in-flight round is re-driven from scratch and its text will be
        // re-emitted; drop the partial count so it is not double-counted.
        // Also clear any armed reset: the re-emitted plan text must not be
        // erased by a stale arm from a tool.output that preceded the retry.
        this.roundChars = 0;
        this.resetArmed = false;
        return;
      default:
        return;
    }
  }

  /**
   * Decide the gate verdict for an `exit_plan_mode` call. Mutates the
   * refusal budget: each `refuse` consumes one; an `ok` resets it.
   */
  check(): PlanTextVerdict {
    if (this.roundChars >= MIN_PLAN_TEXT_CHARS) {
      this.refusals = 0;
      return 'ok';
    }
    if (this.refusals < MAX_PLAN_TEXT_REFUSALS) {
      this.refusals++;
      return 'refuse';
    }
    return 'warn';
  }

  private applyArmedReset(): void {
    if (!this.resetArmed) return;
    this.roundChars = 0;
    this.resetArmed = false;
  }
}

function countVisible(text: string): number {
  return text.replace(/\s+/g, '').length;
}
