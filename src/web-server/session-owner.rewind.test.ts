import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentSession } from '../agent/session/agent-session.js';
import { createMockProvider } from '../agent/__fixtures__/mock-provider.js';
import { createSessionState } from '../agent/providers/anthropic-direct/query/session-state.js';
import { listUserTurns, rewindConversationHistory } from '../agent/providers/anthropic-direct/query/rewind-conversation.js';
import type { ToolDispatcher } from '../agent/providers/anthropic-direct/tool-dispatcher.js';
import type { AbortCoordinator } from '../agent/providers/shared/abort-coordinator.js';
import { loadJournalMessages } from '../agent/journal/index.js';
import { createSessionStats } from '../cli/slash/session-stats.js';
import { coreCommands } from '../cli/slash/commands/core.js';
import { WebSessionControl } from './session-owner.control.js';
import { createWebSlashContext } from './slash-context.web.js';
import { BufferingWriter } from './writer.buffer.js';
import { getSessionLedgerPath } from '../paths.js';
import { handleStream } from './stream-route.js';
import { parseSseChunk } from './sse-protocol.js';
import { COMPACT_ACK_TEXT, COMPACT_SUMMARY_HEADER } from '../agent/providers/shared/compaction.js';

vi.mock('../cli/session-store.js', () => ({ saveSession: vi.fn() }));
const rewind = coreCommands.find((cmd) => cmd.name === '/rewind')!;
const clear = coreCommands.find((cmd) => cmd.name === '/clear')!;
const id = 'rewind-browser';

/** Real AgentSession, native provider JournalSync + native rewind, mock network only. */
function setup(providerId = id, richFirst = false) {
  let native: ReturnType<typeof createSessionState>;
  const provider = createMockProvider({ sessionId: providerId, onTurn: (turn) => {
    const text = String(turn.content);
    native.messages.push({ role: 'user', content: text });
    if (richFirst && text === 'first') native.messages.push(
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'retained thought', signature: 'sig' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'kept.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'retained output' }, { type: 'text', text: 'framework context, not a prompt' }] });
    native.messages.push({ role: 'assistant', content: `Echo: ${text}` });
    native.journalSync.sync(native.messages);
  } });
  const query = provider.query.bind(provider);
  provider.query = (args) => {
    native = createSessionState({ model: 'sonnet', permissionMode: 'default', userSystem: null, toolDispatcher: {} as ToolDispatcher, messageJournal: args.config.messageJournal });
    const q = query(args);
    q.listRewindTargets = () => listUserTurns(native.messages);
    q.rewindConversation = async (index) => rewindConversationHistory({ state: native, abort: { isIdle: () => true } as AbortCoordinator }, index);
    return q;
  };
  const session = new AgentSession({ model: 'sonnet', provider });
  const stats = createSessionStats('sonnet');
  const control = new WebSessionControl(id, session, stats, vi.fn());
  const writer = new BufferingWriter();
  const ctx = createWebSlashContext({ current: session }, stats, writer, '/tmp');
  // Targets newest first: value 1 selects the second prompt, retaining first.
  ctx.choose = vi.fn(async () => '1');
  return { session, control, ctx, writer, provider, native: () => native };
}
async function turn(session: AgentSession, text: string) {
  for await (const _ of session.sendMessageStream(text)) { /* fully drain */ }
}
function records() {
  return readFileSync(getSessionLedgerPath(id), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}
function connect(lastEventId?: string) {
  const req = Object.assign(new EventEmitter(), { headers: lastEventId ? { 'last-event-id': lastEventId } : {} });
  let raw = '';
  const res = { writeHead: vi.fn(), flushHeaders: vi.fn(), write: (text: string) => { raw += text; }, end: vi.fn() };
  const done = handleStream(req as IncomingMessage, res as unknown as ServerResponse, id);
  return { done, res, disconnect: () => req.emit('close'), frames: () => parseSseChunk(raw).events.map((event) => ({ id: event.id, ...JSON.parse(event.data) })) };
}
function visible(tab: ReturnType<typeof connect>) {
  let rows: Array<{ kind: string; text?: string }> = [];
  for (const frame of tab.frames()) {
    if (frame.reset) rows = [];
    if (frame.record) rows.push(frame.record);
  }
  return rows.filter((r) => r.kind === 'user' || r.kind === 'assistant').map((r) => r.text);
}
beforeEach(() => {
  vi.stubEnv('AFK_STATE_DIR', mkdtempSync(join(tmpdir(), 'web-rewind-')));
});
afterEach(() => vi.unstubAllEnvs());

describe('web rewind durable projection', () => {
  it('retains exactly the first of three turns in two tabs, fresh/reload/stale reconnect, then streams a coherent new turn', async () => {
    const s = setup();
    const tabs: ReturnType<typeof connect>[] = [];
    try {
      for (const text of ['first', 'second', 'third']) await turn(s.session, text);
      await s.session.messageJournal!.flush();
      tabs.push(connect(), connect());
      await vi.waitFor(() => tabs.forEach((tab) => expect(visible(tab)).toHaveLength(6)));
      const oldCursor = tabs[0]!.frames().at(-1)!.id;
      const before = statSync(getSessionLedgerPath(id)).ino;
      const result = await s.control.execute(rewind, s.ctx, '');
      expect(result.result).toEqual({ kind: 'prefill', message: 'second' });
      expect(statSync(getSessionLedgerPath(id)).ino).not.toBe(before);
      expect(loadJournalMessages(id)?.map((m) => m.content)).toHaveLength(2);
      await vi.waitFor(() => tabs.forEach((tab) => expect(visible(tab)).toEqual(['first', 'Echo: first'])));
      expect(records().map((r) => r.kind)).toEqual(['meta', 'user', 'assistant', 'done']);
      tabs.push(connect(), connect(oldCursor));
      await vi.waitFor(() => tabs.forEach((tab) => expect(visible(tab)).toEqual(['first', 'Echo: first'])));
      expect(tabs[3]!.frames()[0]).toMatchObject({ reset: true });
      await turn(s.session, 'replacement');
      await vi.waitFor(() => tabs.forEach((tab) => expect(visible(tab)).toEqual(['first', 'Echo: first', 'replacement', 'Echo: replacement'])));
      const cursor = tabs[3]!.frames().at(-1)!.id;
      tabs.push(connect(cursor));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(tabs[4]!.frames()).toEqual([]);
      expect(tabs.slice(0, 4).every((tab) => !tab.res.end.mock.calls.length)).toBe(true);
      await s.session.sealEventLedger();
      expect(records().filter((r) => r.kind === 'done')).toHaveLength(2);
      expect(JSON.stringify(records())).not.toMatch(/second|third/);
    } finally {
      tabs.forEach((tab) => tab.disconnect());
      await Promise.all(tabs.map((tab) => tab.done));
      await s.control.close(); await s.session.close();
    }
  });

  it('rewinding to the first prompt removes all three turns, and clear still works afterward', async () => {
    const s = setup();
    try {
      for (const text of ['first', 'second', 'third']) await turn(s.session, text);
      s.ctx.choose = async () => '2';
      const result = await s.control.execute(rewind, s.ctx, '');
      expect(result.result).toEqual({ kind: 'prefill', message: 'first' });
      expect(records().map((r) => r.kind)).toEqual(['meta']);
      await turn(s.session, 'replacement');
      await s.control.execute(clear, s.ctx, '');
      await turn(s.session, 'after clear');
      await s.session.sealEventLedger();
      expect(records().filter((r) => r.kind === 'user').map((r) => r.text)).toEqual(['after clear']);
    } finally { await s.control.close(); await s.session.close(); }
  });

  it('preserves pre-compaction display history and rich tool/thinking rows instead of model-only summary', async () => {
    const s = setup(id, true);
    try {
      await turn(s.session, 'first');
      const native = s.native();
      await turn(s.session, 'second');
      await turn(s.session, 'third');
      // Model compaction keeps third but the display fold must retain first/second.
      const tail = native.messages.slice(-2);
      native.messages.splice(0, native.messages.length,
        { role: 'user', content: COMPACT_SUMMARY_HEADER + ' model-only summary' },
        { role: 'assistant', content: COMPACT_ACK_TEXT }, ...tail);
      native.journalSync.sync(native.messages, { reason: 'compact' });
      s.ctx.choose = async () => '0'; // newest = third, before model index 2
      await s.control.execute(rewind, s.ctx, '');
      const rows = records();
      expect(rows.filter((r) => r.kind === 'user').map((r) => r.text)).toEqual(['first', 'second']);
      expect(rows.filter((r) => r.kind === 'assistant').map((r) => r.text)).toEqual(['Echo: first', 'Echo: second']);
      expect(rows).toContainEqual(expect.objectContaining({ kind: 'thinking', text: 'retained thought' }));
      expect(rows).toContainEqual(expect.objectContaining({ kind: 'tool', toolUseId: 'tool-1', toolName: 'Read' }));
      expect(rows).toContainEqual(expect.objectContaining({ kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Read', content: 'retained output' }));
      expect(JSON.stringify(rows)).not.toMatch(/third|model-only|framework context/);
      expect(rows.filter((r) => r.kind === 'done')).toEqual([expect.objectContaining({ kind: 'done' }), expect.objectContaining({ kind: 'done' })]);
      // The pre-rewind ledger had real cost records (mock emits 0.001/turn);
      // the projection now carries that total in the last done record so the
      // browser meter does not reset to $0 after a rewind.
      const doneRows = rows.filter((r) => r.kind === 'done');
      // At most one done record may carry costUsd (the last/only retained turn).
      const withCost = doneRows.filter((r) => r.costUsd !== undefined);
      expect(withCost.length).toBeLessThanOrEqual(1);
    } finally { await s.control.close(); await s.session.close(); }
  });

  it('rewinds the post-clear distinct-provider projection and continues without duplicate mirroring', async () => {
    const s = setup('provider-after-clear');
    const tabs: ReturnType<typeof connect>[] = [];
    try {
      await s.control.execute(clear, s.ctx, '');
      for (const text of ['first', 'second', 'third']) await turn(s.session, text);
      tabs.push(connect());
      await vi.waitFor(() => expect(visible(tabs[0]!)).toHaveLength(6));
      await s.control.execute(rewind, s.ctx, '');
      await vi.waitFor(() => expect(visible(tabs[0]!)).toEqual(['first', 'Echo: first']));
      await turn(s.session, 'replacement');
      await vi.waitFor(() => expect(visible(tabs[0]!)).toEqual(['first', 'Echo: first', 'replacement', 'Echo: replacement']));
      await s.control.close();
      expect(records().filter((r) => r.kind === 'user').map((r) => r.text)).toEqual(['first', 'replacement']);
      expect(records().filter((r) => r.kind === 'assistant')).toHaveLength(2);
    } finally {
      tabs.forEach((tab) => tab.disconnect()); await Promise.all(tabs.map((tab) => tab.done));
      await s.control.close(); await s.session.close();
    }
  });

  it('cancel/rejected rewind preserves inode and rows; missing journal fails before provider mutation', async () => {
    const s = setup();
    try {
      await turn(s.session, 'first');
      await s.session.messageJournal!.flush();
      await vi.waitFor(() => expect(records().some((r) => r.kind === 'done')).toBe(true));
      const before = statSync(getSessionLedgerPath(id)).ino;
      s.ctx.choose = async () => null;
      await s.control.execute(rewind, s.ctx, '');
      expect(statSync(getSessionLedgerPath(id)).ino).toBe(before);
      s.ctx.choose = async () => '0';
      s.provider.queries[0]!.rewindConversation = async () => ({ rewound: false, reason: 'turn-in-flight', messagesBefore: 2, messagesAfter: 2 });
      await s.control.execute(rewind, s.ctx, '');
      expect(statSync(getSessionLedgerPath(id)).ino).toBe(before);
      const providerRewind = vi.spyOn(s.provider.queries[0]!, 'rewindConversation');
      vi.spyOn(s.session, 'messageJournal', 'get').mockReturnValue(undefined);
      await expect(s.control.execute(rewind, s.ctx, '')).rejects.toThrow('message journal unavailable');
      expect(providerRewind).not.toHaveBeenCalled();
      expect(records().filter((r) => r.kind === 'user')).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await s.control.close(); await s.session.close(); }
  });
});
