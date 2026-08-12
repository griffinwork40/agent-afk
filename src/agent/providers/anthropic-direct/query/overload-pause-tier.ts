/**
 * Outermost retry tier: bounded pause + replay after a mid-stream overload.
 *
 * Extracted verbatim from `retry-layer.ts` (#824 split); the class keeps a
 * `yield*` delegate. Behavior is unchanged.
 *
 * @module agent/providers/anthropic-direct/query/overload-pause-tier
 */

import type { ProviderEvent } from '../../../provider.js';
import {
  classifyOverloadExhaustion,
  nextProbeDelayMs,
  resolveOverloadPauseCeilingMs,
} from '../overload-pause.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import type { RunTurnInput } from '../types.js';
import type { RetryTierContext, TierGenerator } from './retry-context.js';

/**
 * Outermost tier: bounded pause + replay after a mid-stream overload (529)
 * exhausts its in-loop retry budget (#762).
 *
 * Invariant: this tier keys on the CLEAN `turn.completed` sentinel
 * {@link classifyOverloadExhaustion} matches, NOT on an `error` event. A
 * mid-stream 529 is `new APIError(undefined, <SSE body>, …)` with
 * `status === undefined`, so `classifyUsageLimitError` rejects it at
 * `usage-limit.ts:111` and every pause branch in the usage-limit tier is
 * structurally unreachable for it. Loosening that status check would let
 * unrelated status-less errors into the 2-hour subscription park, so the
 * sentinel is the classification arm instead.
 *
 * Ceilings are plain WALL CLOCK because a 529 carries no reset timestamp —
 * there is nothing for `waitForReset` to key on. Interactive surfaces park up
 * to `OVERLOAD_PAUSE_CEILING_MS`; daemon/cron default to 0 (fail fast).
 *
 * Every exit path re-yields the preserved terminal, so the session ALWAYS
 * seals with a real `closure`: a pause that ends in silence would just
 * re-create the 38-and-63-minute hangs this issue is about. Because the
 * preserved terminal is the turn-committing `turn.completed`, even the
 * ceiling-exhausted path keeps the session resumable.
 *
 * @param next - the usage-limit tier this one wraps.
 */
export async function* turnWithOverloadPause(
  ctx: RetryTierContext,
  runInput: RunTurnInput,
  isClosed: () => boolean,
  next: TierGenerator,
): AsyncGenerator<ProviderEvent, void, void> {
  const ceilingMs = resolveOverloadPauseCeilingMs(ctx.surface);
  // Invariant: the ceiling is measured from when the PARK begins, never from
  // turn start — otherwise the initial turn's own duration silently eats the
  // operator's pause budget, and a long turn could exhaust the ceiling before
  // a single probe fires. Set on the first exhaustion, then held.
  let pauseStartedAt: number | null = null;
  let pauseEmitted = false;

  for (;;) {
    let exhausted: ProviderEvent | null = null;
    for await (const event of next(ctx, runInput, isClosed)) {
      if (classifyOverloadExhaustion(event)) {
        exhausted = event;
        break;
      }
      yield event;
    }

    // Invariant: `overload_resume` means GENUINE recovery, so it is emitted
    // only once the inner stream has ended WITHOUT re-exhausting. A probe that
    // re-exhausts still forwards `OVERLOAD_EXHAUSTED_NOTICE` and any partial
    // deltas BEFORE its sentinel terminal, so gating the resume on "first
    // forwarded event" logged a phantom `outcome: 'recovered'` on every probe
    // — up to 9 per 10-minute park, each followed by a fresh `overload_pause`.
    if (!exhausted) {
      if (pauseEmitted && pauseStartedAt !== null) {
        void emitSessionPhase(runInput.traceWriter, {
          phase: 'overload_resume',
          durationMs: Date.now() - pauseStartedAt,
          metadata: { source: 'retry-layer', outcome: 'recovered' },
        });
      }
      return;
    }

    // Fail-fast surfaces (daemon/cron by default) and an already-ended session
    // surface the preserved terminal immediately. Abort is checked FIRST so a
    // user interrupt always wins over a pause (AbortGraph precedence).
    if (isClosed() || runInput.signal.aborted || ceilingMs === 0) {
      yield exhausted;
      return;
    }

    pauseStartedAt ??= Date.now();
    const remainingMs = ceilingMs - (Date.now() - pauseStartedAt);
    if (remainingMs <= 0) {
      // Ceiling reached: stop probing and surface the preserved terminal so a
      // real `closure` is emitted. Never exits silently.
      if (pauseEmitted) {
        void emitSessionPhase(runInput.traceWriter, {
          phase: 'overload_resume',
          durationMs: Date.now() - pauseStartedAt,
          metadata: { source: 'retry-layer', outcome: 'ceiling-reached' },
        });
      }
      yield exhausted;
      return;
    }

    if (!pauseEmitted) {
      void emitSessionPhase(runInput.traceWriter, {
        phase: 'overload_pause',
        metadata: {
          reason: 'overloaded',
          source: 'retry-layer',
          hasResetTimestamp: false,
          ceilingMs,
          surface: ctx.surface ?? 'unknown',
        },
      });
      pauseEmitted = true;
    }

    // Jittered probe interval — a 529 gives no deadline, so all we can do is
    // re-probe capacity while spreading concurrent sessions apart. Clamped to
    // the REMAINING budget: an unclamped sleep made `ceilingMs` advisory
    // rather than a wall clock (a 1ms ceiling still parked a full 60s, and the
    // 10-minute default overran by nearly two).
    await sleepWithAbort(Math.min(nextProbeDelayMs(), remainingMs), runInput.signal);
    // M1: distinguish close() from interrupt(). A user interrupt (signal.aborted
    // only) exits silently — query-turn-driver.ts synthesizes an `interrupted`
    // terminal, so the seal is `cancelled`. A concurrent close() ALSO sets
    // signal.aborted (both share the per-turn controller), but close() is the
    // end of the session, not a recoverable interrupt — the exhaustion sentinel
    // must reach the session consumer so `lastStopReason` is recorded and the
    // session seals `failed` (not `succeeded`). Check isClosed() FIRST so a
    // simultaneous close+abort takes the close path, which is the stricter one.
    if (isClosed()) { yield exhausted; return; }
    if (runInput.signal.aborted) return;

    runInput.headers = ctx.rotateHeaders(runInput);
    // Invariant: reset the surface BEFORE replaying. The failed attempt's
    // partial deltas and its notice were already forwarded, so without this a
    // recovering probe's output renders appended to the dead attempt's text.
    // Same contract as the in-round reset in `loop.ts`.
    yield { type: 'stream.retry', sessionId: runInput.ctx.sessionId };
  }
}
