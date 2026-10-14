/**
 * Tests for derive.trace.ts — trace-signal extraction for facet downgrade.
 *
 * Covers `parseTraceSignals` with:
 *   - absent / empty file content (no signal)
 *   - each downgrade-relevant closure reason
 *   - non-downgrade closure reasons (model_end_turn, abort, …)
 *   - malformed / partial trace content (resilience)
 *   - subagent_lifecycle.succeeded with stopReason === 'tool_use_loop_capped'
 *   - subagent_lifecycle.succeeded with other stopReasons (no signal)
 *   - both signals present in one trace
 */

import { describe, it, expect } from 'vitest';
import { parseTraceSignals } from './derive.trace.js';

/** Build a minimal, JSON-serialized `closure` trace event. */
function closureLine(reason: string): string {
  return JSON.stringify({
    ts: '2025-01-01T00:00:00.000Z',
    seq: 99,
    kind: 'closure',
    payload: { reason, finalTurnCount: 5, finalCostUsd: 0.01, finalTokens: {} },
  });
}

/**
 * Build a `closure` trace event that optionally carries `subagentId` in its
 * payload — used to simulate descendant (child) closure events interleaved in
 * the root session trace.
 */
function closureLineWithSubagent(reason: string, subagentId?: string): string {
  return JSON.stringify({
    ts: '2025-01-01T00:00:00.000Z',
    seq: 99,
    kind: 'closure',
    payload: {
      reason,
      finalTurnCount: 5,
      finalCostUsd: 0.01,
      finalTokens: {},
      ...(subagentId !== undefined ? { subagentId } : {}),
    },
  });
}

/** Build a minimal `subagent_lifecycle` `succeeded` event. */
function subagentSucceededLine(stopReason?: string): string {
  return JSON.stringify({
    ts: '2025-01-01T00:00:00.000Z',
    seq: 50,
    kind: 'subagent_lifecycle',
    payload: {
      transition: 'succeeded',
      subagentId: 'sub-abc',
      durationMs: 1000,
      turnCount: 3,
      outputBytes: 200,
      ...(stopReason !== undefined ? { stopReason } : {}),
    },
  });
}

/** Build a minimal `subagent_lifecycle` `started` event (not succeeded). */
function subagentStartedLine(): string {
  return JSON.stringify({
    ts: '2025-01-01T00:00:00.000Z',
    seq: 10,
    kind: 'subagent_lifecycle',
    payload: {
      transition: 'started',
      subagentId: 'sub-abc',
      parentId: 'root',
      model: 'sonnet',
    },
  });
}

describe('parseTraceSignals', () => {
  // --- empty / absent content ---

  it('returns no signal for empty content', () => {
    const signals = parseTraceSignals('');
    expect(signals.traceClosureReason).toBeUndefined();
    expect(signals.hasSubagentBudgetExhaustion).toBe(false);
  });

  it('returns no signal for whitespace-only content', () => {
    const signals = parseTraceSignals('   \n   \n');
    expect(signals.traceClosureReason).toBeUndefined();
    expect(signals.hasSubagentBudgetExhaustion).toBe(false);
  });

  it('returns no signal when there is no closure event', () => {
    const content = subagentSucceededLine('end_turn');
    const signals = parseTraceSignals(content);
    expect(signals.traceClosureReason).toBeUndefined();
    expect(signals.hasSubagentBudgetExhaustion).toBe(false);
  });

  // --- closure reason: downgrade-relevant ---

  it('extracts budget_exceeded closure reason', () => {
    const signals = parseTraceSignals(closureLine('budget_exceeded'));
    expect(signals.traceClosureReason).toBe('budget_exceeded');
  });

  it('extracts iteration_cap closure reason', () => {
    const signals = parseTraceSignals(closureLine('iteration_cap'));
    expect(signals.traceClosureReason).toBe('iteration_cap');
  });

  it('extracts truncated closure reason', () => {
    const signals = parseTraceSignals(closureLine('truncated'));
    expect(signals.traceClosureReason).toBe('truncated');
  });

  // --- closure reason: not downgrade-relevant ---

  it('ignores model_end_turn — clean closure is not a downgrade signal', () => {
    const signals = parseTraceSignals(closureLine('model_end_turn'));
    expect(signals.traceClosureReason).toBeUndefined();
  });

  it('ignores abort closure reason', () => {
    const signals = parseTraceSignals(closureLine('abort'));
    expect(signals.traceClosureReason).toBeUndefined();
  });

  it('ignores timeout closure reason', () => {
    const signals = parseTraceSignals(closureLine('timeout'));
    expect(signals.traceClosureReason).toBeUndefined();
  });

  it('ignores hook_blocked closure reason', () => {
    const signals = parseTraceSignals(closureLine('hook_blocked'));
    expect(signals.traceClosureReason).toBeUndefined();
  });

  it('ignores max_turns_exceeded closure reason', () => {
    const signals = parseTraceSignals(closureLine('max_turns_exceeded'));
    expect(signals.traceClosureReason).toBeUndefined();
  });

  // --- subagent budget exhaustion ---

  it('detects subagent_budget_exhaustion from tool_use_loop_capped stopReason', () => {
    const content = subagentSucceededLine('tool_use_loop_capped');
    const signals = parseTraceSignals(content);
    expect(signals.hasSubagentBudgetExhaustion).toBe(true);
  });

  it('does not flag exhaustion for a subagent with clean end_turn stopReason', () => {
    const content = subagentSucceededLine('end_turn');
    const signals = parseTraceSignals(content);
    expect(signals.hasSubagentBudgetExhaustion).toBe(false);
  });

  it('does not flag exhaustion when stopReason is absent', () => {
    const content = subagentSucceededLine(); // no stopReason
    const signals = parseTraceSignals(content);
    expect(signals.hasSubagentBudgetExhaustion).toBe(false);
  });

  it('does not flag exhaustion from a started (not succeeded) lifecycle event', () => {
    // Only 'succeeded' transitions with the right stopReason count.
    const content = subagentStartedLine();
    const signals = parseTraceSignals(content);
    expect(signals.hasSubagentBudgetExhaustion).toBe(false);
  });

  it('detects exhaustion even when only one of N subagents hit the cap', () => {
    const lines = [
      subagentSucceededLine('end_turn'),       // clean
      subagentSucceededLine('tool_use_loop_capped'),  // capped
      subagentSucceededLine('end_turn'),       // clean
    ].join('\n');
    const signals = parseTraceSignals(lines);
    expect(signals.hasSubagentBudgetExhaustion).toBe(true);
  });

  // --- both signals in one trace ---

  it('extracts both closure reason and subagent exhaustion from one trace', () => {
    const content = [
      subagentStartedLine(),
      subagentSucceededLine('tool_use_loop_capped'),
      closureLine('budget_exceeded'),
    ].join('\n');
    const signals = parseTraceSignals(content);
    expect(signals.traceClosureReason).toBe('budget_exceeded');
    expect(signals.hasSubagentBudgetExhaustion).toBe(true);
  });

  // --- resilience ---

  it('skips malformed JSON lines without throwing', () => {
    const content = [
      'not-json at all',
      closureLine('iteration_cap'),
      '{broken json',
    ].join('\n');
    const signals = parseTraceSignals(content);
    expect(signals.traceClosureReason).toBe('iteration_cap');
  });

  it('skips blank lines without throwing', () => {
    const content = '\n\n' + closureLine('truncated') + '\n\n';
    const signals = parseTraceSignals(content);
    expect(signals.traceClosureReason).toBe('truncated');
  });

  it('handles a trace with only unrecognised event kinds gracefully', () => {
    const content = JSON.stringify({ kind: 'unknown_future_kind', payload: {}, ts: 'x', seq: 0 });
    const signals = parseTraceSignals(content);
    expect(signals.traceClosureReason).toBeUndefined();
    expect(signals.hasSubagentBudgetExhaustion).toBe(false);
  });

  // --- root-vs-child closure interleaving ---

  it('ignores child budget_exceeded closure before root model_end_turn closure', () => {
    // Child's closure has subagentId — must be skipped.
    // Root's closure has no subagentId — model_end_turn is not a downgrade signal.
    const content = [
      closureLineWithSubagent('budget_exceeded', 'child-sub-001'),
      closureLineWithSubagent('model_end_turn'),
    ].join('\n');
    const signals = parseTraceSignals(content);
    expect(signals.traceClosureReason).toBeUndefined();
  });

  it('returns no closure signal when only child closures are present (no root closure)', () => {
    // Two child closures, both budget_exceeded — root never closed, so no signal.
    const content = [
      closureLineWithSubagent('budget_exceeded', 'child-sub-001'),
      closureLineWithSubagent('budget_exceeded', 'child-sub-002'),
    ].join('\n');
    const signals = parseTraceSignals(content);
    expect(signals.traceClosureReason).toBeUndefined();
  });

  it('accepts a root-only clean closure (no subagentId) as non-downgrade', () => {
    const content = closureLineWithSubagent('model_end_turn'); // no subagentId — root
    const signals = parseTraceSignals(content);
    expect(signals.traceClosureReason).toBeUndefined();
  });

  it('reports root budget_exceeded even when a child closure with iteration_cap comes first', () => {
    // Child closed with iteration_cap — must NOT influence the root signal.
    // Root closed with budget_exceeded — IS a downgrade signal.
    const content = [
      closureLineWithSubagent('iteration_cap', 'child-sub-001'),
      closureLineWithSubagent('budget_exceeded'), // no subagentId — root
    ].join('\n');
    const signals = parseTraceSignals(content);
    expect(signals.traceClosureReason).toBe('budget_exceeded');
  });
});
