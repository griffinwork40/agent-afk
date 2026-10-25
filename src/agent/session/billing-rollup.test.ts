/**
 * #3878 per-provider billing rollups: the BillingRollup itself, its wiring
 * into AccountingAccumulator (root per turn, subagents per completion), and
 * the `session_sealed.billing` payload (schema-valid, omitted when empty).
 */
import { describe, expect, it, vi } from 'vitest';
import { BillingRollup, sealBillingField } from './billing-rollup.js';
import { AccountingAccumulator } from './accounting-accumulator.js';
import { sealTraceWriter } from './closure-emitter.js';
import { usageToMetadata } from './stream-consumer.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { SessionSealedPayloadSchema } from '../trace/events.js';
import { anthropicBilling, openAICompatibleBilling, sumBillingUsage } from '../usage.billing.js';

const anth = (input: number, read: number, write: number, out = 0) =>
  anthropicBilling({ input_tokens: input, output_tokens: out, cache_read_input_tokens: read, cache_creation_input_tokens: write });

describe('BillingRollup', () => {
  it('splits totals by provider', () => {
    const r = new BillingRollup();
    r.add(anth(10, 900, 90, 5));
    r.add(anth(20, 800, 0, 5));
    r.add(openAICompatibleBilling(1_000, 600, 7));
    r.add(undefined);
    expect(r.snapshot()).toEqual({
      total: { uncachedInput: 430, cacheRead: 2_300, cacheWrite: 90, output: 17 },
      byProvider: {
        'anthropic-direct': { uncachedInput: 30, cacheRead: 1_700, cacheWrite: 90, output: 10 },
        'openai-compatible': { uncachedInput: 400, cacheRead: 600, cacheWrite: 0, output: 7 },
      },
    });
  });

  it('snapshot is undefined when nothing was recorded, and after reset', () => {
    const r = new BillingRollup();
    expect(r.snapshot()).toBeUndefined();
    r.add(anth(1, 0, 0));
    r.reset();
    expect(r.snapshot()).toBeUndefined();
  });

  it('snapshot is defined when usage was reported even if every counter is zero', () => {
    const r = new BillingRollup();
    r.add(anth(0, 0, 0, 0));
    expect(r.snapshot()).toEqual({
      total: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      byProvider: { 'anthropic-direct': { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 } },
    });
  });

  it('snapshot is a copy (later adds do not mutate a prior snapshot)', () => {
    const r = new BillingRollup();
    r.add(anth(1, 0, 0));
    const snap = r.snapshot()!;
    r.add(anth(5, 0, 0));
    expect(snap.total.uncachedInput).toBe(1);
  });

  it('provider: mixed — sumBillingUsage mismatch accumulates under mixed bucket', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = new BillingRollup();
    const mixed = sumBillingUsage(anth(10, 200, 50, 5), openAICompatibleBilling(300, 100, 8));
    expect(mixed?.provider).toBe('mixed');
    r.add(mixed);
    r.add(anth(5, 100, 0, 2)); // normal record added alongside
    const snap = r.snapshot()!;
    expect(snap.byProvider['mixed']).toEqual({ uncachedInput: 210, cacheRead: 300, cacheWrite: 50, output: 13 });
    expect(snap.byProvider['anthropic-direct']).toEqual({ uncachedInput: 5, cacheRead: 100, cacheWrite: 0, output: 2 });
    expect(snap.total).toEqual({ uncachedInput: 215, cacheRead: 400, cacheWrite: 50, output: 15 });
    // The warn is the behavioral signal that 'mixed' was produced.
    expect(warnSpy).toHaveBeenCalledOnce();
    // Exhaustive key check: no stale 'openai-compatible' key alongside 'mixed'.
    expect(Object.keys(snap.byProvider).sort()).toEqual(['anthropic-direct', 'mixed']);
    warnSpy.mockRestore();
  });
});

describe('AccountingAccumulator billing wiring', () => {
  it('root: accumulates billing from each turn metadata; legacy counters unchanged', () => {
    const acc = new AccountingAccumulator();
    for (let i = 0; i < 2; i++) {
      acc.recordTurnMetadata(
        usageToMetadata(
          { inputTokens: 50, cachedInputTokens: 900, outputTokens: 5, billing: anth(50, 1_800, 100, 5) },
          's',
        ),
      );
    }
    const snap = acc.snapshot();
    expect(snap.sessionRunningTokens).toEqual({ input: 100, output: 10, cacheRead: 1_800, cacheCreation: 0 });
    expect(snap.sessionBilling?.total).toEqual({ uncachedInput: 100, cacheRead: 3_600, cacheWrite: 200, output: 10 });
  });

  it('subagents: rolls up per provider; legacy subagent counters unchanged', () => {
    const acc = new AccountingAccumulator();
    acc.recordSubagentCompletion({ inputTokens: 10, cacheReadTokens: 5, billing: anth(10, 5_000, 0) }, 0.01);
    acc.recordSubagentCompletion(
      { inputTokens: 30_000, cacheReadTokens: 9_000, billing: openAICompatibleBilling(30_000, 27_000, 0) },
      undefined,
    );
    acc.recordSubagentCompletion({ inputTokens: 7 }, undefined); // legacy caller, no billing
    const snap = acc.snapshot();
    expect(snap.subagentCompletedCount).toBe(3);
    expect(snap.subagentRunningTokens).toEqual({ input: 30_017, output: 0, cacheRead: 9_005, cacheCreation: 0 });
    expect(snap.subagentBilling?.byProvider).toEqual({
      'anthropic-direct': { uncachedInput: 10, cacheRead: 5_000, cacheWrite: 0, output: 0 },
      'openai-compatible': { uncachedInput: 3_000, cacheRead: 27_000, cacheWrite: 0, output: 0 },
    });
  });

  it('subagents: an outcome-tagged (failed/cancelled) report adds costUsd to subagentRunningCostUsd (#3882 cause 1)', () => {
    // Legacy counters (count, tokens) stay success-only; billing.subagents carries ALL spend.
    // costUsd IS now included for failed/cancelled children so session_sealed.subagentCostUsd
    // reflects total spend across all terminal outcomes (fix for #3882 cause 1).
    const acc = new AccountingAccumulator();
    acc.recordSubagentCompletion({ inputTokens: 10, billing: anth(10, 0, 0) }, 0.5);          // succeeded: $0.50
    acc.recordSubagentCompletion({ billing: anth(7, 3, 1, 2), outcome: 'failed' });             // failed: no costUsd
    acc.recordSubagentCompletion({ billing: openAICompatibleBilling(10, 4, 1), outcome: 'cancelled' }, 9); // cancelled: $9
    const snap = acc.snapshot();
    expect(snap.subagentCompletedCount).toBe(1);
    expect(snap.subagentRunningTokens).toEqual({ input: 10, output: 0, cacheRead: 0, cacheCreation: 0 });
    // $0.50 (succeeded) + $9 (cancelled) = $9.50; failed had no costUsd so contributes $0.
    expect(snap.subagentRunningCostUsd).toBe(9.5);
    expect(snap.subagentBilling?.byProvider).toEqual({
      'anthropic-direct': { uncachedInput: 17, cacheRead: 3, cacheWrite: 1, output: 2 },
      'openai-compatible': { uncachedInput: 6, cacheRead: 4, cacheWrite: 0, output: 1 },
    });
  });

  it('omits billing snapshot keys when no billing was reported, and clears on reset', () => {
    const acc = new AccountingAccumulator();
    acc.recordTurnMetadata({ usage: { input_tokens: 5 } } as Parameters<AccountingAccumulator['recordTurnMetadata']>[0]);
    expect('sessionBilling' in acc.snapshot()).toBe(false);
    expect('subagentBilling' in acc.snapshot()).toBe(false);
    acc.recordSubagentCompletion({ billing: anth(1, 1, 1) });
    acc.reset();
    expect(acc.snapshot().subagentBilling).toBeUndefined();
  });
});

describe('session_sealed.billing', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const base = {
    dispatchReason: 'close',
    signal: new AbortController().signal,
    maxTurnsHit: false,
    hookBlocked: false,
    lastStopReason: undefined,
    sawProviderError: false,
    finalTurnCount: 1,
    finalCostUsd: 0,
    subagentCompletedCount: 0,
    subagentRunningTokens: zero,
    subagentRunningCostUsd: 0,
  };

  it('emits a schema-valid billing field with root and subagent rollups', async () => {
    const root = new BillingRollup();
    root.add(anth(10, 100, 0));
    const subs = new BillingRollup();
    subs.add(openAICompatibleBilling(100, 60, 0));
    const writer = new InMemoryTraceWriter();
    await sealTraceWriter(writer, { ...base, sessionBilling: root.snapshot()!, subagentBilling: subs.snapshot()! });
    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    expect(sealed?.kind).toBe('session_sealed');
    if (sealed?.kind !== 'session_sealed') return;
    expect(sealed.payload.billing?.root?.byProvider['anthropic-direct']?.cacheRead).toBe(100);
    expect(sealed.payload.billing?.subagents?.total).toEqual({ uncachedInput: 40, cacheRead: 60, cacheWrite: 0, output: 0 });
    expect(SessionSealedPayloadSchema.safeParse(sealed.payload).success).toBe(true);
  });

  it('omits billing entirely when neither rollup has data', async () => {
    const writer = new InMemoryTraceWriter();
    await sealTraceWriter(writer, base);
    const sealed = writer.events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('no seal');
    expect('billing' in sealed.payload).toBe(false);
    expect(sealBillingField(undefined, undefined)).toEqual({});
  });
});
