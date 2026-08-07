import { describe, it, expect } from 'vitest';
import { ledgerRecordToItem, accumulateTotals, type SessionTotals } from './ledger-adapter.js';

/**
 * Invariant under test: LedgerRecord is `{ v: 1; ts: number } & LedgerPayload`.
 * The payload is FLATTENED onto the record, not nested under `.payload`.
 * Reading it as nested produced a silently empty transcript — every discriminant
 * lookup missed and every record was dropped, with no error anywhere.
 */
describe('ledgerRecordToItem — flattened record shape', () => {
  it('reads a user record from the flattened shape', () => {
    const item = ledgerRecordToItem({ v: 1, ts: 1, kind: 'user', text: 'hello' });
    expect(item?.kind).toBe('user');
    expect(item && 'text' in item ? item.text : undefined).toBe('hello');
  });

  it('does NOT read a nested payload shape (guards the regression)', () => {
    expect(ledgerRecordToItem({ payload: { kind: 'user', text: 'x' } } as never)).toBeUndefined();
  });

  it('reads an assistant record', () => {
    const item = ledgerRecordToItem({ v: 1, ts: 1, kind: 'assistant', text: 'hi there' });
    expect(item?.kind).toBe('assistant');
  });

  it('reads an error record', () => {
    const item = ledgerRecordToItem({ v: 1, ts: 1, kind: 'error', message: 'boom' });
    expect(item?.kind).toBe('error');
    expect(item && 'message' in item ? item.message : undefined).toBe('boom');
  });
});

describe('ledgerRecordToItem — tool fidelity', () => {
  // The ledger records that a tool STARTED but never persists successful
  // output. Marking it unavailable is what stops the UI from rendering blank
  // space that reads as "the tool returned nothing".
  it('marks a replayed successful tool call as outputUnavailable', () => {
    const item = ledgerRecordToItem({ v: 1, ts: 1, kind: 'tool', toolName: 'bash', input: 'ls' });
    expect(item?.kind).toBe('tool');
    if (item?.kind !== 'tool') throw new Error('expected tool');
    expect(item.status).toBe('ok');
    expect(item.outputUnavailable).toBe(true);
    expect(item.output).toBeUndefined();
    expect(item.name).toBe('bash');
    expect(item.inputPreview).toBe('ls');
  });

  // Failures ARE persisted, so their content is real and must not be flagged.
  it('keeps real content for a tool_error and does not flag it unavailable', () => {
    const item = ledgerRecordToItem({
      v: 1,
      ts: 1,
      kind: 'tool_error',
      toolName: 'bash',
      content: 'exit 1',
    });
    if (item?.kind !== 'tool') throw new Error('expected tool');
    expect(item.status).toBe('error');
    expect(item.output).toBe('exit 1');
    expect(item.outputUnavailable).toBeUndefined();
  });
});

describe('ledgerRecordToItem — non-visual records', () => {
  it('drops meta and the signed remote-control records', () => {
    for (const kind of ['meta', 'elicitation_response', 'abort_request', 'closed']) {
      expect(ledgerRecordToItem({ v: 1, ts: 1, kind })).toBeUndefined();
    }
  });

  it('drops a record with no kind', () => {
    expect(ledgerRecordToItem({ v: 1, ts: 1 })).toBeUndefined();
  });

  it('renders done/paused/resumed as notices', () => {
    expect(ledgerRecordToItem({ kind: 'done', costUsd: 0.5, durationMs: 2000 })?.kind).toBe('notice');
    expect(ledgerRecordToItem({ kind: 'paused' })?.kind).toBe('notice');
    expect(ledgerRecordToItem({ kind: 'resumed' })?.kind).toBe('notice');
  });

  it('formats cost and duration into the done notice', () => {
    const item = ledgerRecordToItem({ kind: 'done', costUsd: 0.1234, durationMs: 3000 });
    if (item?.kind !== 'notice') throw new Error('expected notice');
    expect(item.text).toContain('$0.1234');
    expect(item.text).toContain('3.0s');
  });
});

describe('accumulateTotals', () => {
  const zero: SessionTotals = { costUsd: 0, durationMs: 0, turns: 0 };

  it('accumulates only done records', () => {
    let t = zero;
    t = accumulateTotals(t, { kind: 'user', text: 'x' });
    expect(t.turns).toBe(0);
    t = accumulateTotals(t, { kind: 'done', costUsd: 0.5, durationMs: 1000 });
    t = accumulateTotals(t, { kind: 'done', costUsd: 0.25, durationMs: 500 });
    expect(t.turns).toBe(2);
    expect(t.costUsd).toBeCloseTo(0.75);
    expect(t.durationMs).toBe(1500);
  });

  it('tolerates a done record with no cost or duration', () => {
    const t = accumulateTotals(zero, { kind: 'done' });
    expect(t).toEqual({ costUsd: 0, durationMs: 0, turns: 1 });
  });
});
