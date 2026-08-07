import { describe, expect, it } from 'vitest';
import { createTranscriptModel } from './view-model.js';
import type { OutputEvent } from '../../agent/types/session-types.js';

function last<T>(arr: T[]): T {
  const item = arr[arr.length - 1];
  if (item === undefined) throw new Error('expected non-empty array');
  return item;
}

describe('createTranscriptModel', () => {
  it('creates a user item from a message event', () => {
    const model = createTranscriptModel();
    model.apply({ type: 'message', message: { role: 'user', content: 'hello' } });
    const items = model.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hello' });
  });

  it('accumulates streamed content deltas into one assistant block', () => {
    const model = createTranscriptModel();
    model.apply({ type: 'chunk', chunk: { type: 'content', content: 'Hel' } });
    model.apply({ type: 'chunk', chunk: { type: 'content', content: 'lo' } });
    model.apply({ type: 'chunk', chunk: { type: 'content', content: ' world' } });
    const items = model.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'assistant', text: 'Hello world' });
  });

  it('starts a new assistant block after a done event ends the turn', () => {
    const model = createTranscriptModel();
    model.apply({ type: 'chunk', chunk: { type: 'content', content: 'first' } });
    model.apply({ type: 'done' });
    model.apply({ type: 'chunk', chunk: { type: 'content', content: 'second' } });
    const items = model.getItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'assistant', text: 'first' });
    expect(items[1]).toMatchObject({ kind: 'assistant', text: 'second' });
  });

  it('accumulates streamed thinking deltas into one thinking block', () => {
    const model = createTranscriptModel();
    model.apply({ type: 'chunk', chunk: { type: 'thinking', content: 'step one. ' } });
    model.apply({ type: 'chunk', chunk: { type: 'thinking', content: 'step two.' } });
    const items = model.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'thinking', text: 'step one. step two.' });
  });

  it('correlates tool_use_detail then tool_result by toolUseId into one tool item', () => {
    const model = createTranscriptModel();
    model.apply({
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'bash', toolInput: 'ls -la' },
    });
    let items = model.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'tool', status: 'running', name: 'bash' });

    model.apply({
      type: 'chunk',
      chunk: { type: 'tool_result', toolUseId: 't1', content: 'file1\nfile2', isError: false },
    });
    items = model.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      status: 'ok',
      name: 'bash',
      output: 'file1\nfile2',
    });
    expect((items[0] as { outputUnavailable?: boolean }).outputUnavailable).toBeFalsy();
  });

  it('marks a live successful tool call output present, outputUnavailable falsy', () => {
    const model = createTranscriptModel();
    model.apply({
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'grep', toolInput: 'foo' },
    });
    model.apply(
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 't1', content: 'match: foo', isError: false } },
      { replay: false },
    );
    const item = last(model.getItems());
    expect(item.kind).toBe('tool');
    if (item.kind !== 'tool') throw new Error('unreachable');
    expect(item.status).toBe('ok');
    expect(item.output).toBe('match: foo');
    expect(item.outputUnavailable).toBeFalsy();
  });

  it('marks a replayed successful tool call outputUnavailable=true with no output text', () => {
    const model = createTranscriptModel();
    model.apply(
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'write_file', toolInput: '{}' } },
      { replay: true },
    );
    model.apply(
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 't1', content: '', isError: false } },
      { replay: true },
    );
    const item = last(model.getItems());
    expect(item.kind).toBe('tool');
    if (item.kind !== 'tool') throw new Error('unreachable');
    expect(item.status).toBe('ok');
    expect(item.outputUnavailable).toBe(true);
    expect(item.output).toBeUndefined();
  });

  it('preserves output for a replayed FAILED tool call (errors are persisted)', () => {
    const model = createTranscriptModel();
    model.apply(
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'bash', toolInput: 'false' } },
      { replay: true },
    );
    model.apply(
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 't1', content: 'command failed', isError: true } },
      { replay: true },
    );
    const item = last(model.getItems());
    expect(item.kind).toBe('tool');
    if (item.kind !== 'tool') throw new Error('unreachable');
    expect(item.status).toBe('error');
    expect(item.output).toBe('command failed');
    expect(item.outputUnavailable).toBeFalsy();
  });

  it('never presents an empty string as if it were genuine empty output on replay', () => {
    const model = createTranscriptModel();
    model.apply(
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'edit_file', toolInput: '{}' } },
      { replay: true },
    );
    model.apply(
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 't1', content: '', isError: false } },
      { replay: true },
    );
    const item = last(model.getItems());
    if (item.kind !== 'tool') throw new Error('unreachable');
    // A falsy check on `output` alone must NOT be read as "no output" — the
    // flag is the authoritative signal.
    expect(item.outputUnavailable).toBe(true);
  });

  it('attaches a tool_diff to its matching tool item by toolUseId', () => {
    const model = createTranscriptModel();
    model.apply({
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'edit_file', toolInput: '{}' },
    });
    model.apply({ type: 'chunk', chunk: { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false } });
    const diff = { path: '/a.ts', hunks: [] } as unknown;
    model.apply({
      type: 'chunk',
      chunk: { type: 'tool_diff', toolUseId: 't1', diff: diff as never },
    });
    const item = last(model.getItems());
    if (item.kind !== 'tool') throw new Error('unreachable');
    expect(item.diff).toBe(diff);
  });

  it('drops a tool_diff silently when no matching tool item exists', () => {
    const model = createTranscriptModel();
    model.apply({
      type: 'chunk',
      chunk: { type: 'tool_diff', toolUseId: 'missing', diff: {} as never },
    });
    expect(model.getItems()).toHaveLength(0);
  });

  it('resets the in-progress assistant block on stream_retry instead of appending', () => {
    const model = createTranscriptModel();
    model.apply({ type: 'chunk', chunk: { type: 'content', content: 'partial answer before retry' } });
    model.apply({ type: 'stream_retry' });
    model.apply({ type: 'chunk', chunk: { type: 'content', content: 'full answer after retry' } });
    const items = model.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'assistant', text: 'full answer after retry' });
  });

  it('stream_retry with nothing in progress is a no-op, not a crash', () => {
    const model = createTranscriptModel();
    expect(() => model.apply({ type: 'stream_retry' })).not.toThrow();
    expect(model.getItems()).toHaveLength(0);
  });

  it('records a terminal error event and ends the current turn', () => {
    const model = createTranscriptModel();
    model.apply({ type: 'chunk', chunk: { type: 'content', content: 'partial' } });
    model.apply({ type: 'error', error: new Error('boom') });
    model.apply({ type: 'chunk', chunk: { type: 'content', content: 'next turn' } });
    const items = model.getItems();
    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ kind: 'error', message: 'boom' });
    expect(items[2]).toMatchObject({ kind: 'assistant', text: 'next turn' });
  });

  it('surfaces progress, paused, resumed, and rate_limit as notices', () => {
    const model = createTranscriptModel();
    model.apply({
      type: 'progress',
      progress: { taskId: 'x', description: 'working', totalTokens: 0, toolUses: 0, durationMs: 0 },
    });
    model.apply({ type: 'paused', reason: 'usage-limit' });
    model.apply({ type: 'resumed', hotSwapped: false });
    model.apply({ type: 'rate_limit' });
    const items = model.getItems();
    expect(items).toHaveLength(4);
    for (const item of items) expect(item.kind).toBe('notice');
  });

  it('treats a bare tool_use summary chunk as a notice, not a half-populated tool item', () => {
    const model = createTranscriptModel();
    model.apply({ type: 'chunk', chunk: { type: 'tool_use', content: 'Running bash…' } });
    const items = model.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'notice', text: 'Running bash…' });
  });

  it('a final message event overwrites the streamed assistant block with authoritative text', () => {
    const model = createTranscriptModel();
    model.apply({ type: 'chunk', chunk: { type: 'content', content: 'partial' } });
    model.apply({ type: 'message', message: { role: 'assistant', content: 'final complete text' } });
    const items = model.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'assistant', text: 'final complete text' });
  });

  it('ignores forward-compatible event types outside the documented union without throwing', () => {
    const model = createTranscriptModel();
    const suggestion = { type: 'suggestion', suggestion: 'try X' } as unknown as OutputEvent;
    expect(() => model.apply(suggestion)).not.toThrow();
    expect(model.getItems()).toHaveLength(0);
  });

  it('getItems returns a fresh array each call (no external mutation of internal state)', () => {
    const model = createTranscriptModel();
    model.apply({ type: 'message', message: { role: 'user', content: 'hi' } });
    const first = model.getItems();
    first.push({ kind: 'notice', id: 'injected', text: 'should not persist' });
    const second = model.getItems();
    expect(second).toHaveLength(1);
  });
});
