/**
 * Tests for acp.replay.ts — buildReplayUpdates and emitReplayUpdates.
 *
 * buildReplayUpdates is pure (no I/O) and is tested directly.
 * emitReplayUpdates is tested via a stub loadDisplayMessages + stub peer.
 *
 * @module cli/commands/acp.replay.test
 */

import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { JournalMessage } from '../../agent/journal/types.js';
import type { SessionUpdate } from './acp.wire.js';

// ---------------------------------------------------------------------------
// Mock display-fold and reader so emitReplayUpdates does not hit disk
// ---------------------------------------------------------------------------

const mockLoadDisplayMessages = vi.fn((_id: string): JournalMessage[] => []);
const mockHydrateMessages = vi.fn((m: readonly JournalMessage[]): JournalMessage[] => [...m]);

vi.mock('../../agent/journal/display-fold.js', () => ({
  loadDisplayMessages: (id: string) => mockLoadDisplayMessages(id),
}));

vi.mock('../../agent/journal/reader.js', () => ({
  hydrateMessages: (m: readonly JournalMessage[]) => mockHydrateMessages(m),
}));

vi.mock('./acp.session-map.js', () => ({
  resolveAcpId: (id: string) => id,
}));

const { buildReplayUpdates, emitReplayUpdates } = await import('./acp.replay.js');

// ---------------------------------------------------------------------------
// Helpers to build minimal journal messages
// ---------------------------------------------------------------------------

function userMsg(text: string): JournalMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMsg(text: string): JournalMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function toolUseMsg(id: string, name: string, input: unknown): JournalMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}

function toolResultMsg(toolUseId: string, text: string, isError = false): JournalMessage {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      toolUseId,
      isError,
      content: [{ type: 'text', text }],
    }],
  };
}

// ---------------------------------------------------------------------------
// buildReplayUpdates — pure
// ---------------------------------------------------------------------------

describe('buildReplayUpdates', () => {
  it('empty input → no updates', () => {
    expect(buildReplayUpdates([])).toEqual([]);
  });

  it('user text → user_message_chunk', () => {
    const updates = buildReplayUpdates([userMsg('Hello')]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello' } });
  });

  it('assistant text → agent_message_chunk', () => {
    const updates = buildReplayUpdates([assistantMsg('World')]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'World' } });
  });

  it('tool_use + tool_result pair → tool_call with completed status', () => {
    const msgs = [
      toolUseMsg('tid-1', 'read_file', { file_path: '/a.txt' }),
      toolResultMsg('tid-1', 'old\n'),
    ];
    const updates = buildReplayUpdates(msgs);
    expect(updates).toHaveLength(1);
    const tc = updates[0] as SessionUpdate & { sessionUpdate: 'tool_call' };
    expect(tc.sessionUpdate).toBe('tool_call');
    expect(tc.toolCallId).toBe('tid-1');
    expect(tc.name).toBe('read_file');
    expect(tc.status).toBe('completed');
    expect(tc.rawOutput).toBe('old\n');
  });

  it('error tool_result → failed status', () => {
    const msgs = [
      toolUseMsg('tid-2', 'bash', {}),
      toolResultMsg('tid-2', 'exit 1', true),
    ];
    const updates = buildReplayUpdates(msgs);
    const tc = updates[0] as SessionUpdate & { sessionUpdate: 'tool_call' };
    expect(tc.status).toBe('failed');
  });

  it('fixture scenario: user + tool + assistant', () => {
    // load-replay fixture: user asks, read_file succeeds, assistant responds.
    const msgs = [
      userMsg('Read a.txt'),
      toolUseMsg('tool-1', 'read_file', { file_path: '/workspace/a.txt', offset: 1 }),
      toolResultMsg('tool-1', 'old\n'),
      assistantMsg('The file says old.'),
    ];
    const updates = buildReplayUpdates(msgs);
    // Should produce: user_message_chunk, tool_call, agent_message_chunk
    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatchObject({ sessionUpdate: 'user_message_chunk' });
    expect(updates[1]).toMatchObject({ sessionUpdate: 'tool_call', status: 'completed' });
    expect(updates[2]).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
  });

  it('replayed tool calls use the live display helpers: title, kind and locations', () => {
    // A platform-absolute session cwd: `/workspace` is root-relative on Windows, not absolute.
    const ws = path.join(os.tmpdir(), 'acp-replay-ws');
    const file = path.join(ws, 'a.txt');
    const msgs = [
      toolUseMsg('tool-1', 'read_file', { file_path: file, offset: 1 }),
      toolResultMsg('tool-1', 'old\n'),
      toolUseMsg('tool-2', 'grep', { pattern: 'x', path: 'src' }),
      toolResultMsg('tool-2', 'src/a.ts:1:x'),
    ];
    const [read, grep] = buildReplayUpdates(msgs, ws) as Array<SessionUpdate & { sessionUpdate: 'tool_call' }>;
    expect(read).toEqual({
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: `read_file ${file}`, name: 'read_file',
      kind: 'read', status: 'completed', rawInput: { file_path: file, offset: 1 },
      content: [{ type: 'content', content: { type: 'text', text: 'old\n' } }],
      locations: [{ path: file, line: 1 }], rawOutput: 'old\n',
    });
    // Relative paths resolve against the restored session cwd, as for a live call.
    expect(grep).toMatchObject({ title: `grep "x" in ${path.join(ws, 'src')}`, kind: 'search', locations: [{ path: path.join(ws, 'src') }] });
  });

  it('a nameless historical call gets the generic live display, never a bare empty title', () => {
    const [call] = buildReplayUpdates([toolUseMsg('t', '', {}), toolResultMsg('t', 'r')], '/w') as Array<SessionUpdate & { sessionUpdate: 'tool_call' }>;
    expect(call).toMatchObject({ title: 'Tool call', kind: 'other', locations: [] });
    expect(call).not.toHaveProperty('name');
  });

  it('pure tool-result user message is skipped (no text)', () => {
    // A user message that is ONLY tool_results has no text to emit.
    const msgs = [
      toolUseMsg('tid-3', 'read_file', {}),
      toolResultMsg('tid-3', 'content'),
    ];
    const updates = buildReplayUpdates(msgs);
    // Only the tool_call, no user_message_chunk
    expect(updates.every((u) => u.sessionUpdate !== 'user_message_chunk')).toBe(true);
  });

  it('bounds rawOutput at 65536 bytes', () => {
    const big = 'x'.repeat(70_000);
    const msgs = [
      toolUseMsg('tid-4', 'bash', {}),
      toolResultMsg('tid-4', big),
    ];
    const updates = buildReplayUpdates(msgs);
    const tc = updates[0] as SessionUpdate & { sessionUpdate: 'tool_call' };
    const outputBytes = Buffer.byteLength(tc.rawOutput ?? '', 'utf8');
    expect(outputBytes).toBeLessThanOrEqual(65_536);
    expect(tc.rawOutput).toContain('[truncated]');
  });
});

// ---------------------------------------------------------------------------
// emitReplayUpdates — integration with mocks
// ---------------------------------------------------------------------------

describe('emitReplayUpdates', () => {
  it('resolves immediately when journal is empty', async () => {
    mockLoadDisplayMessages.mockReturnValueOnce([]);
    const notify = vi.fn().mockResolvedValue(undefined);
    await emitReplayUpdates('acp-id', 'afk-id', { request: vi.fn(), notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it('emits notifications in order for a simple history', async () => {
    const history = [userMsg('Hello'), assistantMsg('Hi')];
    mockLoadDisplayMessages.mockReturnValueOnce(history);
    mockHydrateMessages.mockReturnValueOnce(history);

    const notify = vi.fn().mockResolvedValue(undefined);
    await emitReplayUpdates('acp-id', 'afk-id', { request: vi.fn(), notify });

    expect(notify).toHaveBeenCalledTimes(2);
    const [first, second] = notify.mock.calls as Array<[string, { sessionId: string; update: SessionUpdate }]>;
    expect(first[0]).toBe('session/update');
    expect(first[1].sessionId).toBe('acp-id');
    expect(first[1].update.sessionUpdate).toBe('user_message_chunk');
    expect(second[1].update.sessionUpdate).toBe('agent_message_chunk');
  });
});
