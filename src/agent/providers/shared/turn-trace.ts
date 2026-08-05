/**
 * Witness-layer bracket around one provider turn: `loop_start` on entry,
 * `interrupt_halt` + `loop_end` on every exit path, and the
 * interrupt-timestamp bookkeeping the halt-latency measurement needs.
 *
 * Shared by both providers — promoted from `anthropic-direct/loop/turn-trace.ts`
 * after confirming `openai-compatible/query.ts`'s inline equivalent (its own
 * comments describe it as mirroring this one) has no anthropic-SDK-specific
 * coupling and only one behavioral parameter: the `provider` label stamped on
 * the `interrupt_halt` metadata, which each caller now passes explicitly.
 *
 * Contract: this owns a lifetime that belongs to NO single loop phase. The
 * abort listener can fire during any phase (or before the loop starts), and its
 * timestamp is read only at teardown. Grouping it with the round-scoped or
 * turn-scoped tallies would misrepresent when it changes.
 *
 * Every emit is fire-and-forget: a broken or slow trace writer must never stall
 * tool dispatch, nor an already-returning turn.
 *
 * @module agent/providers/shared/turn-trace
 */

import type { TraceWriter } from '../../trace/index.js';
import { emitSessionPhase } from '../../trace/emit.js';

/**
 * Brackets a turn with its witness events. Construct at loop entry (which emits
 * `loop_start`), call {@link finish} from the loop's `finally`.
 */
export class TurnTrace {
  private interruptedAt: number | null;

  /**
   * @param signal      - The turn's abort signal. Watched for the ESC soft-stop.
   * @param traceWriter - Absent on a no-trace session; every method no-ops safely.
   * @param provider    - Stamped onto the `interrupt_halt` metadata so the two
   *                      providers' halt-latency events stay distinguishable.
   */
  constructor(
    private readonly signal: AbortSignal,
    private readonly traceWriter: TraceWriter | undefined,
    private readonly provider: 'anthropic-direct' | 'openai-compatible',
  ) {
    // Invariant: emit order matches the pre-split loop prologue — `loop_start`
    // is the first witness event of the turn, and the interrupt listener is
    // registered after it. Both are synchronous with respect to each other
    // (the emit is fire-and-forget, and neither statement awaits), so no abort
    // can land between them — this ordering is about keeping the trace stream
    // byte-comparable with pre-split sessions, not correctness.

    // Mark loop entry once for this turn.
    void emitSessionPhase(traceWriter, { phase: 'loop_start' });

    // Interrupt→halt latency instrumentation. Stamp the instant the turn signal
    // fires so `finish()` can report ESC→terminal wall-clock in the
    // `interrupt_halt` phase — the field-visible proof the ESC-lag fix keeps the
    // halt within an event-loop turn. A single long-lived listener (not
    // per-event) records the time at most once; `{ once: true }` plus the
    // null-guard make it idempotent. Registered only when a writer is present so
    // a no-trace session pays nothing.
    this.interruptedAt = signal.aborted ? Date.now() : null;
    if (traceWriter && !signal.aborted) {
      signal.addEventListener('abort', this.onInterrupt, { once: true });
    }
  }

  // Bound field, not a method, so add/removeEventListener see one identity.
  private readonly onInterrupt = (): void => {
    if (this.interruptedAt === null) this.interruptedAt = Date.now();
  };

  /**
   * Tear down the listener and emit the closing phases. Called from the
   * generator's `finally`, so it covers every exit path — abort, error, clean
   * end-of-turn, capped — without per-site annotation.
   *
   * `interrupt_halt` is emitted ONLY when this turn ended because of an ESC
   * soft-stop (`interrupt()` aborts with reason `'interrupted'`). Every abort
   * exit yields its terminal `turn.completed` immediately before the generator
   * returns into the `finally`, so `Date.now()` here is that terminal instant
   * while `interruptedAt` is when the signal fired. A session `close()` (reason
   * `'closed'`) and a clean/error/capped end are all excluded — the former is
   * not a halt-latency event, the latter never aborted the signal.
   *
   * @param turnElapsedMs - Whole-turn wall clock, for the `loop_end` duration.
   */
  finish(turnElapsedMs: number): void {
    this.signal.removeEventListener('abort', this.onInterrupt);

    if (this.interruptedAt !== null && this.signal.reason === 'interrupted') {
      void emitSessionPhase(this.traceWriter, {
        phase: 'interrupt_halt',
        durationMs: Date.now() - this.interruptedAt,
        metadata: { provider: this.provider },
      });
    }

    // Emit loop_end regardless of which exit path fired.
    void emitSessionPhase(this.traceWriter, {
      phase: 'loop_end',
      durationMs: turnElapsedMs,
    });
  }
}
