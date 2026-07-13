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

const base: ClosureReasonInputs = {
  dispatchReason: 'close',
  maxTurnsHit: false,
  hookBlocked: false,
  abort: null,
  lastStopReason: undefined,
  sawProviderError: false,
};

describe('isTruncationStopReason', () => {
  it('flags Anthropic max_tokens and OpenAI length', () => {
    expect(isTruncationStopReason('max_tokens')).toBe(true);
    expect(isTruncationStopReason('length')).toBe(true);
  });

  it('does not flag clean / tool / unknown stop reasons', () => {
    expect(isTruncationStopReason('end_turn')).toBe(false);
    expect(isTruncationStopReason('stop')).toBe(false);
    expect(isTruncationStopReason('tool_use')).toBe(false);
    expect(isTruncationStopReason(undefined)).toBe(false);
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
