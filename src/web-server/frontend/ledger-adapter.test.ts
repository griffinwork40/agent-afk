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
    expect(t.costUsd).toBe(0);
    expect(t.durationMs).toBe(0);
    expect(t.turns).toBe(1);
    expect(t.inputTokens).toBe(0);
    expect(t.outputTokens).toBe(0);
    expect(t.cacheReadTokens).toBe(0);
  });

  it('accumulates token breakdown from done records', () => {
    let t = zero;
    t = accumulateTotals(t, { kind: 'done', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
    t = accumulateTotals(t, { kind: 'done', inputTokens: 200, outputTokens: 75 });
    expect(t.inputTokens).toBe(300);
    expect(t.outputTokens).toBe(125);
    expect(t.cacheReadTokens).toBe(10);
    expect(t.turns).toBe(2);
  });
});

describe('ledgerRecordToItem — streaming placeholder suppression', () => {
  // Invariant: the CLI emits two `tool` records per call — a placeholder whose
  // input is the lone ellipsis, then the substantive one. The terminal repaints
  // in place and never shows the first; an append-only surface renders both.
  // In a 338-record sample this was 170 placeholders against 170 finals, i.e.
  // half of every replayed transcript was content-free duplicate rows.
  it('drops the ellipsis placeholder record', () => {
    expect(ledgerRecordToItem({ kind: 'tool', toolName: 'bash', input: ' …' })).toBeUndefined();
    expect(ledgerRecordToItem({ kind: 'tool', toolName: 'bash', input: '…' })).toBeUndefined();
  });

  it('KEEPS a genuinely empty input — a real no-arg call, not a placeholder', () => {
    // browser_close and get_runtime_state legitimately take no arguments; their
    // only record has an empty input. Suppressing on emptiness would erase them.
    const item = ledgerRecordToItem({ kind: 'tool', toolName: 'browser_close', input: '' });
    expect(item).toMatchObject({ kind: 'tool', name: 'browser_close' });
  });

  it('keeps a substantive input, and one that merely contains an ellipsis', () => {
    expect(ledgerRecordToItem({ kind: 'tool', toolName: 'bash', input: 'ls -la' })).toBeDefined();
    const truncated = ledgerRecordToItem({ kind: 'tool', toolName: 'bash', input: 'echo hi …' });
    expect(truncated).toMatchObject({ inputPreview: 'echo hi …' });
  });

  it('keeps a tool named with an ellipsis-like input on a non-tool record', () => {
    expect(ledgerRecordToItem({ kind: 'user', text: '…' })).toMatchObject({ kind: 'user' });
  });
});

describe('ledgerRecordToItem — tool_error legibility', () => {
  // A tool_error record has `content` but no `toolName`, so the row used to
  // render as a bare red "tool" with the error hidden in a collapsed panel.
  it('promotes the error first line into the preview and keeps the full text', () => {
    const item = ledgerRecordToItem({
      kind: 'tool_error',
      content: 'Skill execution error: mint failed at build\nstack frame one\nframe two',
    });
    expect(item).toMatchObject({
      kind: 'tool',
      name: 'error',
      inputPreview: 'Skill execution error: mint failed at build',
      status: 'error',
    });
    expect((item as { output?: string }).output).toContain('frame two');
  });

  it('prefers a real toolName when the record happens to carry one', () => {
    const item = ledgerRecordToItem({ kind: 'tool_error', toolName: 'bash', content: 'boom' });
    expect(item).toMatchObject({ name: 'bash', inputPreview: 'boom' });
  });

  it('tolerates a tool_error with no content at all', () => {
    expect(ledgerRecordToItem({ kind: 'tool_error' })).toMatchObject({
      name: 'error',
      inputPreview: '',
    });
  });
});

describe('ledgerRecordToItem — Wave 1 new kinds', () => {
  it('renders thinking records as ThinkingItems', () => {
    const item = ledgerRecordToItem({ kind: 'thinking', text: 'reasoning...' });
    expect(item?.kind).toBe('thinking');
    expect(item && 'text' in item ? item.text : undefined).toBe('reasoning...');
  });

  it('renders tool_activity as a parallel-wave notice', () => {
    const item3 = ledgerRecordToItem({ kind: 'tool_activity', activeCount: 3, activeToolUseIds: ['a', 'b', 'c'] });
    expect(item3?.kind).toBe('notice');
    expect(item3 && 'text' in item3 ? item3.text : '').toContain('3');
    expect(item3 && 'text' in item3 ? item3.text : '').toContain('parallel');

    const item0 = ledgerRecordToItem({ kind: 'tool_activity', activeCount: 0, activeToolUseIds: [] });
    expect(item0?.kind).toBe('notice');
    expect(item0 && 'text' in item0 ? item0.text : '').toContain('complete');
  });

  it('renders rate_limit as a notice with retry info when available', () => {
    const withDelay = ledgerRecordToItem({ kind: 'rate_limit', retryAfterMs: 5000 });
    expect(withDelay?.kind).toBe('notice');
    expect(withDelay && 'text' in withDelay ? withDelay.text : '').toContain('5s');

    const bare = ledgerRecordToItem({ kind: 'rate_limit' });
    expect(bare?.kind).toBe('notice');
    expect(bare && 'text' in bare ? bare.text : '').toContain('Rate limited');
  });

  it('renders progress as a notice', () => {
    const item = ledgerRecordToItem({ kind: 'progress', message: 'Analyzing code...' });
    expect(item?.kind).toBe('notice');
    expect(item && 'text' in item ? item.text : '').toBe('Analyzing code...');
  });

  it('renders subagent_lifecycle as a notice', () => {
    const item = ledgerRecordToItem({
      kind: 'subagent_lifecycle',
      subagentId: 'sa-abc123',
      status: 'succeeded',
      agentType: 'research-agent',
      durationMs: 2500,
    });
    expect(item?.kind).toBe('notice');
    const text = item && 'text' in item ? item.text : '';
    expect(text).toContain('succeeded');
    expect(text).toContain('research-agent');
    expect(text).toContain('2.5s');
  });

  it('renders background_job as a notice', () => {
    const item = ledgerRecordToItem({ kind: 'background_job', jobId: 'bg-1', status: 'completed', label: 'my task' });
    expect(item?.kind).toBe('notice');
    const text = item && 'text' in item ? item.text : '';
    expect(text).toContain('completed');
    expect(text).toContain('my task');
  });

  it('renders plan_mode as a notice', () => {
    const item = ledgerRecordToItem({ kind: 'plan_mode', mode: 'plan' });
    expect(item?.kind).toBe('notice');
    const text = item && 'text' in item ? item.text : '';
    expect(text).toContain('plan');
  });

  it('done notice includes token breakdown when present', () => {
    const item = ledgerRecordToItem({ kind: 'done', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
    expect(item?.kind).toBe('notice');
    const text = item && 'text' in item ? item.text : '';
    expect(text).toContain('100in');
    expect(text).toContain('50out');
    expect(text).toContain('10cache');
  });
});
