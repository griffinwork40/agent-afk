/**
 * Unit tests for the pure closure-reason classifier extracted from
 * AgentSession (`closure-reason.ts`). Covers the precedence rules in
 * `classifyClosureReason` and the `isTruncationStopReason` predicate.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyClosureReason,
  isTruncationStopReason,
  type ClosureReasonInputs,
} from './closure-reason.js';
import { SOFT_DEADLINE_WIND_DOWN } from '../providers/shared/soft-deadline.js';
import { TRUNCATION_STOP_REASONS } from '../providers/shared/truncation.js';

const base: ClosureReasonInputs = {
  dispatchReason: 'close',
  maxTurnsHit: false,
  hookBlocked: false,
  abort: null,
  lastStopReason: undefined,
  sawProviderError: false,
};

describe('isTruncationStopReason', () => {
  it('flags Anthropic max_tokens and OpenAI Chat Completions length', () => {
    expect(isTruncationStopReason('max_tokens')).toBe(true);
    expect(isTruncationStopReason('length')).toBe(true);
  });

  // The Responses API has no `finish_reason`: responses-translate.ts derives the
  // stop reason from `response.incomplete_details.reason`, which spells this
  // event `'max_output_tokens'` (pinned by responses-translate.test.ts). Missing
  // it un-classified every truncated turn on that wire — the closure reason fell
  // through to `model_end_turn` and a truncated subagent reached its parent with
  // no partial-result banner, which is precisely the invisibility #952 removes.
  it('flags the OpenAI Responses-wire spelling max_output_tokens', () => {
    expect(isTruncationStopReason('max_output_tokens')).toBe(true);
  });

  it('covers every sentinel in TRUNCATION_STOP_REASONS (no drift)', () => {
    for (const reason of TRUNCATION_STOP_REASONS) {
      expect(isTruncationStopReason(reason)).toBe(true);
    }
    expect(TRUNCATION_STOP_REASONS).toContain('max_output_tokens');
  });

  it('does not flag clean / tool / unknown stop reasons', () => {
    expect(isTruncationStopReason('end_turn')).toBe(false);
    expect(isTruncationStopReason('stop')).toBe(false);
    expect(isTruncationStopReason('tool_use')).toBe(false);
    expect(isTruncationStopReason(undefined)).toBe(false);
    expect(isTruncationStopReason(null)).toBe(false);
    // Adjacent but distinct: a *request* field name, never a stop reason.
    expect(isTruncationStopReason('max_completion_tokens')).toBe(false);
  });
});

describe('classifyClosureReason', () => {
  it('returns model_end_turn for a clean close', () => {
    expect(classifyClosureReason(base)).toBe('model_end_turn');
  });

  it('reports truncated when the final turn hit the token ceiling', () => {
    expect(classifyClosureReason({ ...base, lastStopReason: 'max_tokens' })).toBe('truncated');
    expect(classifyClosureReason({ ...base, lastStopReason: 'length' })).toBe('truncated');
  });

  it('reports iteration_cap when the tool-use budget fired', () => {
    expect(
      classifyClosureReason({ ...base, lastStopReason: 'tool_use_loop_capped' }),
    ).toBe('iteration_cap');
  });

  it('reports timeout when the SOFT wall-clock deadline wound the turn down', () => {
    // The graceful wall-clock path (#938). Classified as `timeout` because the
    // budget that ran out WAS the clock — only the handling was gentler than
    // the hard abort. Distinct from the round cap above, which stays
    // `iteration_cap`, so the two budgets never get conflated in telemetry.
    expect(
      classifyClosureReason({ ...base, lastStopReason: SOFT_DEADLINE_WIND_DOWN }),
    ).toBe('timeout');
    expect(
      classifyClosureReason({ ...base, lastStopReason: SOFT_DEADLINE_WIND_DOWN }),
    ).not.toBe('iteration_cap');
  });

  it('an abort signal outranks the iteration cap', () => {
    expect(
      classifyClosureReason({ ...base, abort: 'timeout', lastStopReason: 'tool_use_loop_capped' }),
    ).toBe('timeout');
  });

  it('reports max_turns_exceeded with the highest precedence', () => {
    expect(classifyClosureReason({ ...base, maxTurnsHit: true })).toBe('max_turns_exceeded');
    // The turn-cap throw surfaces as a generic error/abort — the flag must win.
    expect(
      classifyClosureReason({ ...base, maxTurnsHit: true, dispatchReason: 'error' }),
    ).toBe('max_turns_exceeded');
    expect(classifyClosureReason({ ...base, maxTurnsHit: true, abort: 'abort' })).toBe(
      'max_turns_exceeded',
    );
  });

  it('reports hook_blocked when a SessionStart hook blocked', () => {
    expect(
      classifyClosureReason({ ...base, hookBlocked: true, dispatchReason: 'error' }),
    ).toBe('hook_blocked');
  });

  it('prefers max_turns_exceeded over hook_blocked if both are set', () => {
    expect(classifyClosureReason({ ...base, maxTurnsHit: true, hookBlocked: true })).toBe(
      'max_turns_exceeded',
    );
  });

  it('maps a generic init/runtime error to abort', () => {
    expect(classifyClosureReason({ ...base, dispatchReason: 'error' })).toBe('abort');
  });

  it('preserves prior behavior: a generic error outranks the abort-signal class', () => {
    // Pre-refactor order: dispatchReason==='error' returned 'abort' before
    // inspecting the abort signal.
    expect(
      classifyClosureReason({ ...base, dispatchReason: 'error', abort: 'budget_exceeded' }),
    ).toBe('abort');
  });

  it('maps classified abort signals when not a generic error', () => {
    expect(classifyClosureReason({ ...base, abort: 'budget_exceeded' })).toBe('budget_exceeded');
    expect(classifyClosureReason({ ...base, abort: 'timeout' })).toBe('timeout');
    expect(classifyClosureReason({ ...base, abort: 'abort' })).toBe('abort');
  });

  it('an abort signal outranks a truncation stop reason', () => {
    expect(
      classifyClosureReason({ ...base, abort: 'timeout', lastStopReason: 'max_tokens' }),
    ).toBe('timeout');
  });

  it('maps a provider error event on an otherwise-clean close to abort', () => {
    // The silent-success regression: a turn ended in a provider `error` event
    // but the surface closed the session cleanly (dispatchReason='close',
    // no abort signal). Must NOT fall through to model_end_turn.
    expect(classifyClosureReason({ ...base, sawProviderError: true })).toBe('abort');
  });

  // #762: overload exhaustion commits its turn CLEANLY (so the session stays
  // resumable and finalTurnCount > 0), which means sawProviderError is false.
  // The closure must still read `abort` — the turn did not end because the model
  // was done — so the failure stays loud despite the clean terminal.
  it('classifies overload exhaustion as abort even with no provider error', () => {
    expect(
      classifyClosureReason({
        ...base,
        sawProviderError: false,
        lastStopReason: 'overload_exhausted',
      }),
    ).toBe('abort');
  });

  it('a classified abort signal outranks a provider error event', () => {
    // A genuine budget/timeout abort also emits an error event; the more
    // specific abort classification wins.
    expect(
      classifyClosureReason({ ...base, sawProviderError: true, abort: 'budget_exceeded' }),
    ).toBe('budget_exceeded');
  });

  it('a provider error event outranks a truncation stop reason', () => {
    // A later errored turn is the terminal cause even if an earlier turn was
    // truncated (lastStopReason carries the truncated turn's stop reason).
    expect(
      classifyClosureReason({ ...base, sawProviderError: true, lastStopReason: 'max_tokens' }),
    ).toBe('abort');
  });
});
