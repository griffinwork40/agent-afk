/**
 * Unit tests for the terminal-classification + trace-seal helpers in
 * `closure-emitter.ts`.
 *
 * Scope split from the sibling `closure-reason.test.ts`: that file exercises the
 * pure precedence DECISION TREE (`classifyClosureReason`). This file covers the
 * parts of `closure-emitter.ts` that the tree does NOT — the abort-SIGNAL
 * pre-classification layer inside {@link deriveClosureReason} (the
 * `instanceof`/string-prefix error detection + the benign-`'closed'` skip),
 * the {@link deriveSealStatus} mapping, and the writer-driven payload shaping of
 * {@link emitClosureEvent} / {@link sealTraceWriter}. To avoid duplicating the
 * decision-tree coverage, `deriveClosureReason` is tested only for the
 * signal→abort classification it owns plus one delegation touchpoint.
 */

import { describe, it, expect } from 'vitest';
import { BudgetExceededError, TimeoutError } from '../../utils/errors.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import {
  deriveClosureReason,
  deriveSealStatus,
  emitClosureEvent,
  sealTraceWriter,
  type ClosureSignals,
  type ClosureTokenCounters,
} from './closure-emitter.js';
import { CLOSURE_ABORT_RECOVERY_HINT } from './closure-guidance.js';

// A never-aborted signal — the common clean-close case.
const cleanSignal = new AbortController().signal;

/** Build a fired abort signal carrying `reason`. */
function abortedSignal(reason: unknown): AbortSignal {
  const c = new AbortController();
  c.abort(reason);
  return c.signal;
}

const baseSignals: ClosureSignals = {
  dispatchReason: 'close',
  signal: cleanSignal,
  maxTurnsHit: false,
  hookBlocked: false,
  lastStopReason: undefined,
  sawProviderError: false,
};

const zeroTokens: ClosureTokenCounters = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
};

// ---------------------------------------------------------------------------
// deriveClosureReason — abort-signal PRE-classification layer
// (the decision tree itself is covered in closure-reason.test.ts)
// ---------------------------------------------------------------------------

describe('deriveClosureReason', () => {
  it('classifies a BudgetExceededError abort-signal reason as budget_exceeded', () => {
    const signal = abortedSignal(new BudgetExceededError(1, 0.5));
    expect(deriveClosureReason({ ...baseSignals, signal })).toBe('budget_exceeded');
  });

  it('classifies a TimeoutError abort-signal reason as timeout', () => {
    const signal = abortedSignal(new TimeoutError('turn timed out', 1000));
    expect(deriveClosureReason({ ...baseSignals, signal })).toBe('timeout');
  });

  it('falls back to string-prefix matching when the reason was stringified', () => {
    // Some abort paths pass the error MESSAGE (not the instance). The
    // well-known prefixes must still classify accurately.
    expect(
      deriveClosureReason({ ...baseSignals, signal: abortedSignal('Budget ceiling reached: $1') }),
    ).toBe('budget_exceeded');
    expect(
      deriveClosureReason({ ...baseSignals, signal: abortedSignal('operation timed out') }),
    ).toBe('timeout');
  });

  it('maps an unrecognised abort-signal reason to a generic abort', () => {
    expect(
      deriveClosureReason({ ...baseSignals, signal: abortedSignal(new Error('boom')) }),
    ).toBe('abort');
    expect(deriveClosureReason({ ...baseSignals, signal: abortedSignal('whatever') })).toBe('abort');
  });

  it('treats the benign "closed" teardown reason as NOT an abort', () => {
    // close() aborts its own controller with reason 'closed' as normal
    // teardown — that must not surface as a cancellation-flavored reason.
    const reason = deriveClosureReason({ ...baseSignals, signal: abortedSignal('closed') });
    expect(reason).toBe('model_end_turn');
  });

  it('returns model_end_turn for a never-aborted clean close', () => {
    expect(deriveClosureReason(baseSignals)).toBe('model_end_turn');
  });

  it('delegates precedence to the decision tree (a classified abort wins over the signal path)', () => {
    // maxTurnsHit is checked FIRST in classifyClosureReason, so it must win
    // even though the signal would otherwise classify as budget_exceeded.
    // This confirms deriveClosureReason forwards its inputs to the tree.
    const signal = abortedSignal(new BudgetExceededError(1, 0.5));
    expect(deriveClosureReason({ ...baseSignals, signal, maxTurnsHit: true })).toBe(
      'max_turns_exceeded',
    );
  });
});

// ---------------------------------------------------------------------------
// deriveSealStatus — closure → seal-status mapping + precedence
// ---------------------------------------------------------------------------

describe('deriveSealStatus', () => {
  it("maps dispatchReason 'error' to failed", () => {
    expect(deriveSealStatus({ ...baseSignals, dispatchReason: 'error' })).toBe('failed');
  });

  it('maps a fired abort signal (reason !== "closed") to cancelled', () => {
    expect(deriveSealStatus({ ...baseSignals, signal: abortedSignal('user') })).toBe('cancelled');
    expect(
      deriveSealStatus({ ...baseSignals, signal: abortedSignal(new TimeoutError('t', 1)) }),
    ).toBe('cancelled');
  });

  it('maps a lone provider error (no abort, not dispatch=error) to failed', () => {
    expect(deriveSealStatus({ ...baseSignals, sawProviderError: true })).toBe('failed');
  });

  it('maps an otherwise-clean close to succeeded', () => {
    expect(deriveSealStatus(baseSignals)).toBe('succeeded');
  });

  it('treats the benign "closed" abort reason as succeeded, not cancelled', () => {
    expect(deriveSealStatus({ ...baseSignals, signal: abortedSignal('closed') })).toBe('succeeded');
  });

  it("prefers failed when dispatchReason is 'error' even if the signal aborted", () => {
    // 'error' is checked before the signal, so it wins.
    expect(
      deriveSealStatus({ ...baseSignals, dispatchReason: 'error', signal: abortedSignal('x') }),
    ).toBe('failed');
  });

  it('prefers cancelled over a provider error (abort beats sawProviderError)', () => {
    // A genuine cancel/budget/timeout abort also emits an error event; the
    // more-specific cancelled status must win over the failed fallback.
    expect(
      deriveSealStatus({ ...baseSignals, signal: abortedSignal('user'), sawProviderError: true }),
    ).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// emitClosureEvent — writer no-op + closure payload shaping
// ---------------------------------------------------------------------------

describe('emitClosureEvent', () => {
  it('is a no-op when the writer is undefined', async () => {
    // Must simply resolve without throwing.
    await expect(
      emitClosureEvent(undefined, {
        ...baseSignals,
        finalTurnCount: 1,
        finalCostUsd: 0,
        runningTokens: zeroTokens,
      }),
    ).resolves.toBeUndefined();
  });

  it('emits a closure event carrying the derived reason and totals', async () => {
    const writer = new InMemoryTraceWriter();
    await emitClosureEvent(writer, {
      ...baseSignals,
      finalTurnCount: 3,
      finalCostUsd: 0.25,
      runningTokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
    });

    expect(writer.events).toHaveLength(1);
    const ev = writer.events[0];
    expect(ev?.kind).toBe('closure');
    if (ev?.kind === 'closure') {
      expect(ev.payload.reason).toBe('model_end_turn');
      expect(ev.payload.finalTurnCount).toBe(3);
      expect(ev.payload.finalCostUsd).toBe(0.25);
      // Only positive token fields are included.
      expect(ev.payload.finalTokens).toEqual({ input: 100, output: 50 });
    }
  });

  it('omits every zero-valued token field and the guidance for benign closes', async () => {
    const writer = new InMemoryTraceWriter();
    await emitClosureEvent(writer, {
      ...baseSignals,
      finalTurnCount: 0,
      finalCostUsd: 0,
      runningTokens: zeroTokens,
    });

    const ev = writer.events[0];
    if (ev?.kind === 'closure') {
      expect(ev.payload.finalTokens).toEqual({});
      expect(ev.payload.guidance).toBeUndefined();
      expect(ev.payload.lastStopReason).toBeUndefined();
    }
  });

  it('attaches the recovery guidance hint for an abort closure', async () => {
    const writer = new InMemoryTraceWriter();
    await emitClosureEvent(writer, {
      ...baseSignals,
      signal: abortedSignal(new Error('boom')),
      finalTurnCount: 1,
      finalCostUsd: 0,
      runningTokens: zeroTokens,
    });

    const ev = writer.events[0];
    if (ev?.kind === 'closure') {
      expect(ev.payload.reason).toBe('abort');
      expect(ev.payload.guidance).toBe(CLOSURE_ABORT_RECOVERY_HINT);
    }
  });

  it('includes lastStopReason when present', async () => {
    const writer = new InMemoryTraceWriter();
    await emitClosureEvent(writer, {
      ...baseSignals,
      lastStopReason: 'max_tokens',
      finalTurnCount: 1,
      finalCostUsd: 0,
      runningTokens: zeroTokens,
    });

    const ev = writer.events[0];
    if (ev?.kind === 'closure') {
      // max_tokens on an otherwise-clean close classifies as truncated.
      expect(ev.payload.reason).toBe('truncated');
      expect(ev.payload.lastStopReason).toBe('max_tokens');
    }
  });
});

// ---------------------------------------------------------------------------
// sealTraceWriter — writer no-op + session_sealed payload shaping
// ---------------------------------------------------------------------------

describe('sealTraceWriter', () => {
  const sealBase = {
    ...baseSignals,
    finalTurnCount: 2,
    finalCostUsd: 0.1,
    subagentCompletedCount: 0,
    subagentRunningTokens: zeroTokens,
    subagentRunningCostUsd: 0,
  };

  it('is a no-op when the writer is undefined', async () => {
    await expect(sealTraceWriter(undefined, sealBase)).resolves.toBeUndefined();
  });

  it('seals with the derived status and core totals', async () => {
    const writer = new InMemoryTraceWriter();
    await sealTraceWriter(writer, sealBase);

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    expect(sealed).toBeDefined();
    if (sealed?.kind === 'session_sealed') {
      expect(sealed.payload.status).toBe('succeeded');
      expect(sealed.payload.finalTurnCount).toBe(2);
      expect(sealed.payload.finalCostUsd).toBe(0.1);
      expect(typeof sealed.payload.closedAt).toBe('string');
      // No subagent activity → all rollup fields omitted.
      expect(sealed.payload.subagentCount).toBeUndefined();
      expect(sealed.payload.subagentTokens).toBeUndefined();
      expect(sealed.payload.subagentCostUsd).toBeUndefined();
    }
  });

  it('propagates a cancelled status from a fired abort signal', async () => {
    const writer = new InMemoryTraceWriter();
    await sealTraceWriter(writer, { ...sealBase, signal: abortedSignal('user') });

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind === 'session_sealed') {
      expect(sealed.payload.status).toBe('cancelled');
    }
  });

  it('includes subagent rollup fields only when non-zero', async () => {
    const writer = new InMemoryTraceWriter();
    await sealTraceWriter(writer, {
      ...sealBase,
      subagentCompletedCount: 2,
      subagentRunningTokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      subagentRunningCostUsd: 0.03,
    });

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind === 'session_sealed') {
      expect(sealed.payload.subagentCount).toBe(2);
      // Only positive token sub-fields are present.
      expect(sealed.payload.subagentTokens).toEqual({ input: 10, output: 5 });
      expect(sealed.payload.subagentCostUsd).toBe(0.03);
    }
  });

  it('omits subagentTokens entirely when every sub-count is zero but a subagent completed', async () => {
    const writer = new InMemoryTraceWriter();
    await sealTraceWriter(writer, {
      ...sealBase,
      subagentCompletedCount: 1,
      subagentRunningTokens: zeroTokens,
      subagentRunningCostUsd: 0,
    });

    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind === 'session_sealed') {
      expect(sealed.payload.subagentCount).toBe(1);
      expect(sealed.payload.subagentTokens).toBeUndefined();
      expect(sealed.payload.subagentCostUsd).toBeUndefined();
    }
  });
});
