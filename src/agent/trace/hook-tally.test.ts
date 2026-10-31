/**
 * hook_decision suppression + hook_summary emission.
 *
 * Covers: allow-path rows not written; block / reason / injected-context /
 * approval rows still written byte-identically; summary counts include the
 * suppressed rows; summary emitted exactly once, just before session_sealed;
 * summary emission is fire-and-forget when the writer fails (INV-040);
 * a wrapping sink with `hookTallyKey` tallies into its inner writer.
 */

import { describe, it, expect } from 'vitest';
import { emitHookDecision } from './emit.js';
import { isInformativeHookDecision, takeHookSummary } from './hook-tally.js';
import { InMemoryTraceWriter } from './writer.js';
import type { TraceSink } from './writer.js';
import type { HookDecisionPayload, TraceEventInput } from './types.js';
import { sealTraceWriter } from '../session/closure-emitter.js';

const sealInput = {
  dispatchReason: 'close',
  signal: new AbortController().signal,
  maxTurnsHit: false,
  hookBlocked: false,
  lastStopReason: undefined,
  sawProviderError: false,
  finalTurnCount: 1,
  finalCostUsd: 0,
  subagentCompletedCount: 0,
  subagentRunningTokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  subagentRunningCostUsd: 0,
};

function hookRows(w: InMemoryTraceWriter): HookDecisionPayload[] {
  return w.events.flatMap((e) => (e.kind === 'hook_decision' ? [e.payload] : []));
}

describe('emitHookDecision suppression', () => {
  it('does not write a row carrying only hookEvent (and subagentId)', async () => {
    const w = new InMemoryTraceWriter();
    await emitHookDecision(w, { hookEvent: 'PreToolUse' });
    await emitHookDecision(w, { hookEvent: 'PostToolUse', decision: undefined });
    await emitHookDecision(w, { hookEvent: 'PreToolUse', subagentId: 'child-1' });
    expect(hookRows(w)).toHaveLength(0);
  });

  it.each<[string, HookDecisionPayload]>([
    ['block', { hookEvent: 'PreToolUse', decision: 'block', blockedTool: 'bash', reason: 'no' }],
    ['approve', { hookEvent: 'SessionStart', decision: 'approve' }],
    ['reason only', { hookEvent: 'Stop', reason: 'note' }],
    ['injected context', { hookEvent: 'PreToolUse', injectedContextBytes: 12 }],
    ['approval carve-out', { hookEvent: 'PreToolUse', blockedTool: 'bash', durationMs: 1, approvalOutcome: 'carve-out' }],
    ['approval approved (no decision)', { hookEvent: 'PreToolUse', durationMs: 5, approvalOutcome: 'approved' }],
  ])('writes informative row unchanged: %s', async (_label, payload) => {
    const w = new InMemoryTraceWriter();
    await emitHookDecision(w, payload);
    expect(hookRows(w)).toEqual([payload]);
  });

  it('isInformativeHookDecision ignores subagentId alone', () => {
    expect(isInformativeHookDecision({ hookEvent: 'PreToolUse', subagentId: 'x' })).toBe(false);
    expect(isInformativeHookDecision({ hookEvent: 'PreToolUse', reason: '' })).toBe(false);
  });

  it('isInformativeHookDecision: ruleId alone (no decision) is NOT informative', () => {
    expect(isInformativeHookDecision({ hookEvent: 'PreToolUse', ruleId: 'x' })).toBe(false);
  });

  it('isInformativeHookDecision: empty-string reason alone is NOT informative', () => {
    expect(isInformativeHookDecision({ hookEvent: 'PreToolUse', reason: '' })).toBe(false);
    expect(isInformativeHookDecision({ hookEvent: 'Stop', reason: '' })).toBe(false);
    // Non-empty reason IS still informative
    expect(isInformativeHookDecision({ hookEvent: 'Stop', reason: 'note' })).toBe(true);
  });

  it('isInformativeHookDecision: durationMs alone is informative', () => {
    expect(isInformativeHookDecision({ hookEvent: 'PreToolUse', durationMs: 42 })).toBe(true);
  });

  it('isInformativeHookDecision: ruleId alone is NOT informative', () => {
    expect(isInformativeHookDecision({ hookEvent: 'PreToolUse', ruleId: 'x' })).toBe(false);
  });

  it('isInformativeHookDecision: ruleId with decision IS informative', () => {
    expect(isInformativeHookDecision({ hookEvent: 'PreToolUse', decision: 'block', ruleId: 'x' })).toBe(true);
  });

  it('is a no-op with no writer', async () => {
    await expect(emitHookDecision(undefined, { hookEvent: 'PreToolUse' })).resolves.toBeUndefined();
  });
});

describe('hook_summary', () => {
  it('counts written + suppressed dispatches by hookEvent x decision|allow, before session_sealed', async () => {
    const w = new InMemoryTraceWriter();
    await emitHookDecision(w, { hookEvent: 'PreToolUse' });
    await emitHookDecision(w, { hookEvent: 'PreToolUse' });
    await emitHookDecision(w, { hookEvent: 'PreToolUse', decision: 'block', reason: 'r' });
    await emitHookDecision(w, { hookEvent: 'PostToolUse', subagentId: 'c1' });
    await emitHookDecision(w, { hookEvent: 'PreToolUse', injectedContextBytes: 3 });
    await sealTraceWriter(w, sealInput);

    const kinds = w.events.map((e) => e.kind);
    expect(kinds.slice(-2)).toEqual(['hook_summary', 'session_sealed']);
    const summary = w.events.find((e) => e.kind === 'hook_summary');
    if (summary?.kind !== 'hook_summary') throw new Error('missing hook_summary');
    expect(summary.payload).toEqual({
      scope: 'root-session-including-subagents',
      counts: { PreToolUse: { allow: 3, block: 1 }, PostToolUse: { allow: 1 } },
      written: 2,
      suppressed: 3,
    });
  });

  it('emits a zero-count summary when no hooks fired', async () => {
    const w = new InMemoryTraceWriter();
    await sealTraceWriter(w, sealInput);
    const summary = w.events.find((e) => e.kind === 'hook_summary');
    if (summary?.kind !== 'hook_summary') throw new Error('missing hook_summary');
    expect(summary.payload.counts).toEqual({});
    expect(summary.payload.suppressed).toBe(0);
  });

  it('is emitted once even if seal is attempted twice', async () => {
    const w = new InMemoryTraceWriter();
    await emitHookDecision(w, { hookEvent: 'Stop' });
    await sealTraceWriter(w, sealInput);
    await sealTraceWriter(w, sealInput);
    expect(w.events.filter((e) => e.kind === 'hook_summary')).toHaveLength(1);
    expect(takeHookSummary(w)).toBeUndefined();
  });

  it('is fire-and-forget: a failing writer does not block the seal', async () => {
    const inner = new InMemoryTraceWriter();
    let sealed = false;
    const failing = {
      getTracePath: () => inner.getTracePath(),
      write: async (e: TraceEventInput) => {
        if (e.kind === 'hook_summary') throw new Error('disk full');
        await inner.write(e);
      },
      seal: async () => {
        sealed = true;
      },
      close: async () => {},
    };
    await emitHookDecision(failing, { hookEvent: 'PreToolUse' });
    await expect(sealTraceWriter(failing, sealInput)).resolves.toBeUndefined();
    expect(sealed).toBe(true);
  });

  it('a wrapping sink with hookTallyKey tallies into the wrapped writer', async () => {
    const inner = new InMemoryTraceWriter();
    const shim: TraceSink & { hookTallyKey: TraceSink } = {
      hookTallyKey: inner,
      getTracePath: () => inner.getTracePath(),
      write: (e) => inner.write(e),
    };
    await emitHookDecision(shim, { hookEvent: 'PreToolUse' });
    await emitHookDecision(inner, { hookEvent: 'PreToolUse' });
    await sealTraceWriter(inner, sealInput);
    const summary = inner.events.find((e) => e.kind === 'hook_summary');
    if (summary?.kind !== 'hook_summary') throw new Error('missing hook_summary');
    expect(summary.payload.counts).toEqual({ PreToolUse: { allow: 2 } });
  });
});
