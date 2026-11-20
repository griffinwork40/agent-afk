import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslatorState, finishTurn, translateOutputEvent } from './acp.translate.js';
import { checked } from './__test-utils__/acp-schema.js';
import type { OutputEvent } from '../../agent/types/session-types.js';
import type { MessageChunk } from '../../agent/types/message-types.js';
import type { TranslatorState, TurnMetadata } from './acp.wire.js';
import type { DiffPayload } from '../../utils/diff.js';

const cwd = path.resolve('workspace');
const detail = (name = 'read_file', id = 't', raw = '{"file_path":"a.txt","offset":1}'): MessageChunk => ({ type: 'tool_use_detail', toolUseId: id, toolName: name, toolInput: 'human summary', toolInputRaw: raw });
const diff: DiffPayload = { addedLines: 1, removedLines: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: '-', text: 'old' }, { kind: '+', text: 'new' }] }] };
function emit(st: TranslatorState, chunk: MessageChunk) { return checked(translateOutputEvent({ type: 'chunk', chunk }, st, { cwd })); }
function finish(st: TranslatorState, meta?: TurnMetadata) { const result = finishTurn(st, meta); checked(result.updates); return result; }

describe('ACP stream translation', () => {
  it('creates independent session state', () => {
    const a = createTranslatorState(); const b = createTranslatorState();
    expect(a.cancelled).toBe(false); expect(a.tools).toBeInstanceOf(Map); expect(a.tools).not.toBe(b.tools);
  });
  it('emits only actual text and thinking chunks, not tool summaries or final message duplicates', () => {
    const st = createTranslatorState();
    expect(emit(st, { type: 'content', content: 'Hello' })).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } }]);
    expect(emit(st, { type: 'thinking', content: 'Reasoning' })).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reasoning' } }]);
    expect(emit(st, { type: 'tool_use', content: 'Using tool', metadata: { precedingToolUseIds: ['t'] } })).toEqual([]);
    for (const event of [
      { type: 'message', message: { role: 'assistant', content: 'Hello' } },
      { type: 'notice', kind: 'refusal', text: 'Refused' },
      { type: 'error', error: new Error('secret') }, { type: 'stream_retry' },
      { type: 'subagent_lifecycle', subagentId: 'child', status: 'started' },
    ] satisfies OutputEvent[]) expect(checked(translateOutputEvent(event, st, { cwd }))).toEqual([]);
  });
  it('suppresses placeholder details, emits one read start, caches parsed input and name', () => {
    const st = createTranslatorState();
    expect(emit(st, { ...detail(), pending: true } as MessageChunk)).toEqual([]);
    expect(st.tools.size).toBe(0);
    expect(emit(st, detail())).toEqual([{ sessionUpdate: 'tool_call', toolCallId: 't', title: 'read_file a.txt', name: 'read_file', kind: 'read', status: 'in_progress', content: [], locations: [{ path: path.join(cwd, 'a.txt'), line: 1 }], rawInput: { file_path: 'a.txt', offset: 1 } }]);
    expect(emit(st, detail())).toEqual([]);
    expect(emit(st, { type: 'tool_result', toolUseId: 't', content: 'old\n' })).toEqual([{ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', rawOutput: 'old\n', content: [{ type: 'content', content: { type: 'text', text: 'old\n' } }] }]);
    expect(st.tools.get('t')?.name).toBe('read_file');
  });
  it('starts consent tools pending and never regresses already approved permission state', () => {
    const st = createTranslatorState();
    expect(emit(st, detail('bash'))[0]).toMatchObject({ status: 'pending', kind: 'execute' });
    st.tools.set('edit', { name: 'edit_file', input: { file_path: 'a.txt', offset: 1 }, announced: true, status: 'in_progress', content: [] });
    expect(emit(st, detail('edit_file', 'edit'))).toEqual([]);
    expect(st.tools.get('edit')?.status).toBe('in_progress');
    expect(emit(st, { type: 'tool_result', toolUseId: 'edit', content: 'Permission denied: rejected', isError: true })[0]).toMatchObject({ status: 'failed' });
    expect(finish(st).stopReason).toBe('end_turn');
  });
  it('drops missing ids, defaults missing names, uses cached names, never parses the summary', () => {
    const st = createTranslatorState();
    expect(emit(st, detail('bash', ''))).toEqual([]);
    expect(emit(st, { type: 'tool_result', toolUseId: '', content: 'x' })).toEqual([]);
    expect(emit(st, { type: 'tool_diff', toolUseId: '', diff })).toEqual([]);
    expect(emit(st, detail('', 'unknown', '{'))[0]).toEqual({ sessionUpdate: 'tool_call', toolCallId: 'unknown', title: 'Tool call', kind: 'other', status: 'pending', content: [], locations: [] });
    st.tools.set('cached', { name: 'read_file', input: { file_path: 'a.txt' }, announced: false, status: 'in_progress', content: [] });
    expect(emit(st, detail('', 'cached', '{'))[0]).toMatchObject({ name: 'read_file', rawInput: { file_path: 'a.txt' } });
    expect(emit(st, detail('read_file', 'bad', '{'))[0]).not.toHaveProperty('rawInput');
  });
  it('announces generic orphan results before their terminal update and drops unknown diffs', () => {
    const st = createTranslatorState();
    const updates = emit(st, { type: 'tool_result', toolUseId: 'orphan', content: 'result' });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'orphan', title: 'Tool call', kind: 'other' });
    expect(updates[1]).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'completed' });
    expect(emit(st, { type: 'tool_diff', toolUseId: 'unknown', diff })).toEqual([]);
  });
  it('retains earlier diffs with result replacement content and supports late diffs without status regression', () => {
    const st = createTranslatorState(); emit(st, detail('edit_file'));
    const rendered = { type: 'diff', path: path.join(cwd, 'a.txt'), oldText: 'old', newText: 'new' };
    expect(emit(st, { type: 'tool_diff', toolUseId: 't', diff })).toEqual([{ sessionUpdate: 'tool_call_update', toolCallId: 't', content: [rendered] }]);
    expect(emit(st, { type: 'tool_result', toolUseId: 't', content: 'OK' })[0]).toMatchObject({ status: 'completed', content: [rendered, { type: 'content', content: { type: 'text', text: 'OK' } }] });
    const late = emit(st, { type: 'tool_diff', toolUseId: 't', diff });
    expect(late[0]).not.toHaveProperty('status');
    expect(st.tools.get('t')?.status).toBe('completed');
    expect(st.tools.get('t')?.content).toHaveLength(3);
  });
  it('bounds UTF-8 results including marker, does not emit image blocks', () => {
    const st = createTranslatorState(); emit(st, detail('view_image'));
    const updates = emit(st, { type: 'tool_result', toolUseId: 't', content: '😀'.repeat(20000) });
    const terminal = updates[updates.length - 1]!;
    expect(terminal).toHaveProperty('rawOutput');
    if ('rawOutput' in terminal && terminal.rawOutput !== undefined) {
      expect(Buffer.byteLength(terminal.rawOutput)).toBeLessThanOrEqual(65536);
      expect(terminal.rawOutput).toMatch(/\n\[truncated\]$/);
      expect(terminal.rawOutput).not.toContain('�');
      expect(terminal.content).toEqual([{ type: 'content', content: { type: 'text', text: terminal.rawOutput } }]);
    }
  });
  it('omits oversize escaped rawInput and replaces oversize accumulated diffs with bounded text', () => {
    const st = createTranslatorState();
    const start = emit(st, detail('edit_file', 't', JSON.stringify({ file_path: 'a.txt', content: '\u0000'.repeat(200000) })))[0]!;
    expect(start).not.toHaveProperty('rawInput');
    const huge = { ...diff, hunks: [{ ...diff.hunks[0]!, lines: [{ kind: '+' as const, text: '\u0000'.repeat(200000) }] }] };
    const updates = emit(st, { type: 'tool_diff', toolUseId: 't', diff: huge });
    expect(updates[0]).toMatchObject({ content: [{ type: 'content', content: { type: 'text', text: 'Diff omitted: exceeds transport limit' } }] });
    const final = emit(st, { type: 'tool_result', toolUseId: 't', content: 'OK' });
    expect(JSON.stringify(final)).not.toContain('newText');
    expect(Buffer.byteLength(JSON.stringify(final[0]))).toBeLessThan(1048576);
  });
});

describe('ACP transport edge cases', () => {
  it('bounds start display metadata for huge file paths and patch location collections', () => {
    for (const [name, input] of [
      ['read_file', { file_path: 'x'.repeat(1100000) }],
      ['patch_apply', { changes: Array.from({ length: 20000 }, (_, i) => ({ path: `${i}-${'x'.repeat(100)}` })) }],
    ] as const) {
      const updates = emit(createTranslatorState(), detail(name, 't', JSON.stringify(input)));
      for (const update of updates) expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } }))).toBeLessThan(1048576);
    }
  });
  it('keeps one sticky diff omission marker across multiple overflows and later results', () => {
    const st = createTranslatorState(); emit(st, detail('edit_file'));
    const huge = { ...diff, hunks: [{ ...diff.hunks[0]!, lines: [{ kind: '+' as const, text: 'x'.repeat(200000) }] }] };
    emit(st, { type: 'tool_diff', toolUseId: 't', diff: huge });
    emit(st, { type: 'tool_diff', toolUseId: 't', diff });
    emit(st, { type: 'tool_diff', toolUseId: 't', diff: huge });
    const final = emit(st, { type: 'tool_result', toolUseId: 't', content: 'OK' });
    expect(final[0]).toMatchObject({ content: [
      { type: 'content', content: { type: 'text', text: 'Diff omitted: exceeds transport limit' } },
      { type: 'content', content: { type: 'text', text: 'OK' } },
    ] });
  });
  it('fits a final frame with maximum escaped result text and retained diffs', () => {
    const st = createTranslatorState(); emit(st, detail('edit_file'));
    const large = { ...diff, hunks: [{ ...diff.hunks[0]!, lines: [{ kind: '+' as const, text: 'x'.repeat(130000) }] }] };
    emit(st, { type: 'tool_diff', toolUseId: 't', diff: large });
    for (const update of emit(st, { type: 'tool_result', toolUseId: 't', content: '\u0000'.repeat(65536) })) {
      expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } }))).toBeLessThan(1048576);
    }
  });
  it('preserves valid scalar raw JSON and drops malformed/nonfinite values', () => {
    for (const raw of ['null', 'true', '42', '"hello"', '[1,2]']) {
      expect(emit(createTranslatorState(), detail('unknown', 't', raw))[0]).toHaveProperty('rawInput', JSON.parse(raw));
    }
    for (const raw of ['{', '1e400', '{"value":1e400}']) expect(emit(createTranslatorState(), detail('read_file', 't', raw))[0]).not.toHaveProperty('rawInput');
  });
});

describe('ACP final usage and stop reason', () => {
  it('uses context occupancy and accumulates per-turn measured costs exactly once', () => {
    const st = createTranslatorState(); st.contextWindowSize = 200000;
    const meta = { totalCostUsd: 0.01, usage: { context_window_tokens: 1024, input_tokens: 9999, output_tokens: 9999 }, costUsd: 900 };
    expect(checked(translateOutputEvent({ type: 'done', metadata: meta }, st, { cwd }))).toEqual([]);
    expect(finish(st).updates).toEqual([{ sessionUpdate: 'usage_update', used: 1024, size: 200000, cost: { amount: 0.01, currency: 'USD' } }]);
    expect(finish(st, { ...meta, totalCostUsd: 0.02 }).updates[0]).toMatchObject({ cost: { amount: 0.03 } });
    expect(finish(st).updates).toEqual([]);
  });
  it('omits usage unless both context counts are safe nonnegative integers', () => {
    for (const value of [undefined, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1024']) {
      const st = createTranslatorState(); st.contextWindowSize = 200000;
      expect(finish(st, { usage: { context_window_tokens: value } }).updates).toEqual([]);
    }
    for (const size of [undefined, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const st = createTranslatorState(); if (size !== undefined) st.contextWindowSize = size;
      expect(finish(st, { usage: { context_window_tokens: 0 } }).updates).toEqual([]);
    }
    const st = createTranslatorState(); st.contextWindowSize = 0;
    expect(finish(st, { totalCostUsd: 0, usage: { context_window_tokens: 0 } }).updates).toEqual([{ sessionUpdate: 'usage_update', used: 0, size: 0, cost: { amount: 0, currency: 'USD' } }]);
  });
  it('cost is omitted forever after missing/invalid measurement or incomplete restore', () => {
    for (const cost of [undefined, NaN, Infinity, -1]) {
      const st = createTranslatorState(); st.contextWindowSize = 100;
      finish(st, cost === undefined ? {} : { totalCostUsd: cost });
      expect(finish(st, { totalCostUsd: 1, usage: { context_window_tokens: 5 } }).updates[0]).not.toHaveProperty('cost');
    }
    const st = createTranslatorState(); st.costIncomplete = true; st.contextWindowSize = 100;
    expect(finish(st, { totalCostUsd: 1, usage: { context_window_tokens: 5 } }).updates[0]).not.toHaveProperty('cost');
  });
  for (const [reason, expected] of [
    ['end_turn', 'end_turn'], ['stop', 'end_turn'], ['max_tokens', 'max_tokens'], ['length', 'max_tokens'], ['max_output_tokens', 'max_tokens'],
    ['tool_use_loop_capped', 'max_turn_requests'], ['max_turn_requests', 'max_turn_requests'], ['refusal', 'refusal'], ['content_filter', 'refusal'], ['interrupted', 'cancelled'],
  ]) it(`maps ${reason} to ${expected}, with cancellation taking precedence`, () => {
    const st = createTranslatorState(); expect(finish(st, { stopReason: reason }).stopReason).toBe(expected);
    st.cancelled = true; expect(finish(st, { stopReason: reason }).stopReason).toBe('cancelled');
  });
  it('maps max-turn result subtype and does not clear tool history on finish', () => {
    const st = createTranslatorState(); emit(st, detail());
    expect(finish(st, { resultSubtype: 'error_max_turns' }).stopReason).toBe('max_turn_requests');
    expect(st.tools.size).toBe(1);
  });
});
