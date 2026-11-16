/**
 * Tests for the fatal-turn `done` invariant (issue #4830).
 *
 * Contract:
 *   - Success path: exactly one `done` in the stream with real metadata;
 *     no extra `done` in the ledger (the stream `done` IS the ledger record).
 *   - Fatal provider error: stream yields `error` and NO `done`; ledger records
 *     exactly one `done` with stopReason 'error' and numeric durationMs, ordered
 *     after the error record.
 *   - Early-break consumer: breaking on the first event lets the generator chain
 *     complete (`query()` finalises, provider close is called).
 *   - stopReason helper unit tests: string reason → interrupted, AbortError →
 *     interrupted, BudgetExceededError → budget_ceiling, IdleWatchdogError →
 *     stalled, not aborted → error.
 *
 * @module agent/session/turn-stream-runner.fatal-done.test
 */

// Ledger writes are isolated by the global setup file
// src/__test-utils__/redirect-paths-env.ts (per-file AFK_HOME sentinel).
import { describe, it, expect } from 'vitest';
import { AgentSession } from './agent-session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { query } from '../query.js';
import { readLedger, type LedgerRecord } from '../session-ledger.js';
import { fatalStopReason } from './turn-stream-runner.fatal-done.js';
import type { OutputEvent } from '../types.js';

async function collectEvents(session: AgentSession, message: string): Promise<OutputEvent[]> {
  const events: OutputEvent[] = [];
  for await (const event of session.sendMessageStream(message)) {
    events.push(event);
  }
  return events;
}

async function collectLedger(sessionId: string): Promise<LedgerRecord[]> {
  const out: LedgerRecord[] = [];
  for await (const r of readLedger(sessionId)) out.push(r);
  return out;
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------
describe('success path', () => {
  it('emits exactly one done in the stream with real metadata', async () => {
    const sessionId = `fatal-done-success-${Date.now()}`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({ model: 'sonnet', provider });

    const events = await collectEvents(session, 'hello');
    await session.close();

    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0] as Extract<OutputEvent, { type: 'done' }>;
    expect(done.metadata?.stopReason).toBe('end_turn');
    expect(typeof done.metadata?.durationMs).toBe('number');
  });

  it('does not write an extra done to the ledger on success', async () => {
    const sessionId = `fatal-done-success-ledger-${Date.now()}`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({ model: 'sonnet', provider });

    await collectEvents(session, 'hello');
    await session.close();

    const records = await collectLedger(sessionId);
    const doneRecords = records.filter((r) => r.kind === 'done');
    // Exactly one done: the real turn.completed record, no synthetic duplicate.
    expect(doneRecords).toHaveLength(1);
    expect(doneRecords[0]!.stopReason).toBe('end_turn');
  });
});

// ---------------------------------------------------------------------------
// Fatal provider error path
// ---------------------------------------------------------------------------
describe('fatal provider error path', () => {
  it('stream yields error and NO done', async () => {
    const sessionId = `fatal-done-err-stream-${Date.now()}`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({ model: 'sonnet', provider });

    const events = await collectEvents(session, 'provider-error');
    await session.close();

    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(0);
  });

  it('ledger records exactly one done with stopReason error and numeric durationMs', async () => {
    const sessionId = `fatal-done-err-ledger-${Date.now()}`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({ model: 'sonnet', provider });

    await collectEvents(session, 'provider-error');
    await session.close();

    const records = await collectLedger(sessionId);
    const doneRecords = records.filter((r) => r.kind === 'done');
    expect(doneRecords).toHaveLength(1);
    expect(doneRecords[0]!.stopReason).toBe('error');
    expect(typeof doneRecords[0]!.durationMs).toBe('number');
  });

  it('ledger done is ordered after the error record', async () => {
    const sessionId = `fatal-done-err-order-${Date.now()}`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({ model: 'sonnet', provider });

    await collectEvents(session, 'provider-error');
    await session.close();

    const records = await collectLedger(sessionId);
    const errorIdx = records.findIndex((r) => r.kind === 'error');
    const doneIdx = records.findIndex((r) => r.kind === 'done');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(errorIdx);
  });
});

// ---------------------------------------------------------------------------
// Early-break consumer: generator chain completes, provider close is called
// ---------------------------------------------------------------------------
describe('early-break consumer', () => {
  it('provider close is called when consumer breaks on first event', async () => {
    const provider = createMockProvider();
    // Break immediately after the first event — exercises generator return().
    for await (const _event of query('hello', { provider, apiKey: 'test-key' })) {
      break;
    }
    expect(provider.queries[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('provider close is called when consumer breaks on error event', async () => {
    const provider = createMockProvider();
    for await (const event of query('provider-error', { provider, apiKey: 'test-key' })) {
      if (event.type === 'error') break;
    }
    expect(provider.queries[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// fatalStopReason unit tests
// ---------------------------------------------------------------------------
describe('fatalStopReason()', () => {
  function makeSignal(aborted: boolean, reason?: unknown): AbortSignal {
    const ctrl = new AbortController();
    if (aborted) ctrl.abort(reason);
    return ctrl.signal;
  }

  it('returns error when signal is not aborted', () => {
    expect(fatalStopReason(makeSignal(false))).toBe('error');
  });

  it('returns interrupted for a plain string reason', () => {
    expect(fatalStopReason(makeSignal(true, 'interrupted'))).toBe('interrupted');
    expect(fatalStopReason(makeSignal(true, 'sigterm'))).toBe('interrupted');
  });

  it('returns interrupted for AbortError', () => {
    const err = { name: 'AbortError', message: 'aborted' };
    expect(fatalStopReason(makeSignal(true, err))).toBe('interrupted');
  });

  it('returns budget_ceiling for BudgetExceededError', () => {
    const err = { name: 'BudgetExceededError', message: 'over budget' };
    expect(fatalStopReason(makeSignal(true, err))).toBe('budget_ceiling');
  });

  it('returns stalled for IdleWatchdogError', () => {
    const err = { name: 'IdleWatchdogError', message: 'idle' };
    expect(fatalStopReason(makeSignal(true, err))).toBe('stalled');
  });

  it('returns error for unknown aborted reason', () => {
    expect(fatalStopReason(makeSignal(true, { name: 'SomeOtherError' }))).toBe('error');
    expect(fatalStopReason(makeSignal(true, 42))).toBe('error');
    expect(fatalStopReason(makeSignal(true, null))).toBe('error');
  });
});
