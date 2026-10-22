import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { LedgerLifecycle } from '../agent/session/ledger-lifecycle.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSessionControl } from './session-owner.control.js';
import { createSessionStats } from '../cli/slash/session-stats.js';
import { BufferingWriter } from './writer.buffer.js';
import { createWebSlashContext } from './slash-context.web.js';
import { FastModeController } from '../agent/fast-mode.js';
import { getSessionLedgerPath } from '../paths.js';
import { setSessionModel, setSessionName, setSessionThinking, setSessionFast } from '../agent/session-control/index.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import type { SlashCommand } from '../cli/slash/types.js';
import { coreCommands } from '../cli/slash/commands/core.js';
import { infoCommands } from '../cli/slash/commands/info.js';

vi.mock('../cli/session-store.js', () => ({ saveSession: vi.fn() }));
import { saveSession } from '../cli/session-store.js';

function setup() {
  const stats = createSessionStats('sonnet');
  const fake = {
    sessionId: 'stable-web',
    reset: vi.fn(async () => { fake.sessionId = 'fresh-provider'; }),
    waitForInitialization: vi.fn(async () => ({ sessionId: fake.sessionId })),
    setModel: vi.fn(),
    pushSidebandEvent: vi.fn(),
    recordLedgerElicitation: vi.fn(),
    listRewindTargets: vi.fn(() => []),
    compact: vi.fn(async () => ({ compacted: false, reason: 'nothing-to-summarize' })),
    hookRegistry: { dispatch: vi.fn() },
    async *sendMessageStream() {
      yield { type: 'message', message: { role: 'assistant', content: 'new answer' } };
      yield { type: 'done', metadata: {} };
    },
  };
  const session = fake as unknown as AgentSession;
  const metadata = vi.fn();
  const controller = new FastModeController();
  const control = new WebSessionControl('stable-web', session, stats, metadata, controller);
  const writer = new BufferingWriter();
  const ctx = createWebSlashContext({ current: session }, stats, writer, '/tmp');
  return { stats, fake, session, metadata, controller, control, writer, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AFK_STATE_DIR', mkdtempSync(join(tmpdir(), 'web-control-')));
});
afterEach(() => vi.unstubAllEnvs());

const command = (name: string, handler: SlashCommand['handler'] = async () => 'continue'): SlashCommand => ({ name, summary: 'test', handler });

describe('WebSessionControl', () => {
  it('only returns clear after canonical reset succeeds; keeps stable stats key', async () => {
    const s = setup();
    const saver = s.control.autosaver(vi.fn());
    saver.saveTurn('old question', 'old answer', { sessionId: 'stable-web' });
    const handler = vi.fn();
    const response = await s.control.execute(command('/clear', handler), s.ctx, '');
    expect(response.control).toEqual({ kind: 'clear' });
    expect(handler).not.toHaveBeenCalled();
    expect(s.fake.reset).toHaveBeenCalledOnce();
    expect(s.stats).toMatchObject({ sessionId: 'stable-web', totalTurns: 0, turns: [] });
    expect(s.metadata).toHaveBeenCalledWith({ model: 'sonnet' });
    expect(saveSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'fresh-provider', totalTurns: 0 }), 'stable-web');
    await s.control.close();
    expect(readFileSync(getSessionLedgerPath('stable-web'), 'utf8')).not.toContain('old answer');
  });

  it('same-id provider is the sole writer after repeated resets (real LedgerLifecycle)', async () => {
    const s = setup();
    const ledger = new LedgerLifecycle();
    const ensure = () => ledger.ensure({ sessionId: 'stable-web', fallbackModel: 'sonnet', depth: undefined, parentSessionId: undefined, tracePath: undefined, getMetadata: () => ({ model: 'sonnet' }) });
    s.fake.reset.mockImplementation(async () => { await ledger.seal('reset'); });
    s.fake.sendMessageStream = async function* () {
      ensure();
      ledger.recordUser('provider question');
      const event = { type: 'message' as const, message: { role: 'assistant' as const, content: 'new answer' } };
      ledger.recordEvent(event);
      yield event;
      const done = { type: 'done' as const, metadata: {} };
      ledger.recordEvent(done);
      yield done;
    };
    ensure();
    ledger.recordUser('old question');
    await ledger.seal('reset');
    const originalInode = statSync(getSessionLedgerPath('stable-web')).ino;
    await s.control.execute(command('/clear'), s.ctx, '');
    expect(statSync(getSessionLedgerPath('stable-web')).ino).not.toBe(originalInode);
    for await (const _ of s.session.sendMessageStream('wrapper question')) { /* drain */ }
    await s.control.execute(command('/clear'), s.ctx, '');
    for await (const _ of s.session.sendMessageStream('wrapper question')) { /* drain */ }
    await ledger.seal('close');
    await s.control.close();
    const records = readFileSync(getSessionLedgerPath('stable-web'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records.filter((r) => r.kind === 'user')).toEqual([expect.objectContaining({ text: 'provider question' })]);
    expect(records.filter((r) => r.kind === 'assistant')).toHaveLength(1);
    expect(records.filter((r) => r.kind === 'closed')).toHaveLength(1);
    expect(saveSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'stable-web' }), 'stable-web');
  });

  it('returns the actual thinking mode as authoritative response metadata', async () => {
    const s = setup();
    const response = await s.control.execute(command('/thinking', async (ctx) => {
      setSessionThinking(ctx.stats, 'off');
      return 'continue';
    }), s.ctx, 'off');
    expect(response.session?.thinkingUi).toBe('off');
  });

  it('does not clear accounting or emit success when reset rejects', async () => {
    const s = setup();
    s.stats.totalTurns = 2;
    s.fake.reset.mockRejectedValueOnce(new Error('reset denied'));
    await expect(s.control.execute(command('/clear'), s.ctx, '')).rejects.toThrow('reset denied');
    expect(s.stats.totalTurns).toBe(2);
    expect(s.writer.getChunks()).toEqual([]);
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('clears persisted projection and mirrors new turns under stable browser id', async () => {
    const s = setup();
    await s.control.execute(command('/clear'), s.ctx, '');
    // Close flushes projection; the new provider id does not change browser id.
    for await (const _event of s.session.sendMessageStream('fresh question')) { /* drain */ }
    await s.control.close();
    const records = readFileSync(getSessionLedgerPath('stable-web'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((r) => r.kind)).toEqual(['meta', 'user', 'assistant', 'done', 'closed']);
    expect(records[1]).toMatchObject({ text: 'fresh question' });
    expect(records[2]).toMatchObject({ text: 'new answer' });
  });

  it('repeated clear removes prior stable projection without double wrapping', async () => {
    const s = setup();
    await s.control.execute(command('/clear'), s.ctx, '');
    for await (const _ of s.session.sendMessageStream('discard')) { /* drain */ }
    await s.control.execute(command('/clear'), s.ctx, '');
    for await (const _ of s.session.sendMessageStream('keep')) { /* drain */ }
    await s.control.close();
    const text = readFileSync(getSessionLedgerPath('stable-web'), 'utf8');
    expect(text).not.toContain('discard');
    expect(text.match(/"kind":"user"/g)).toHaveLength(1);
  });

  it('uses live stats for rename/model and the next turn saves exactly once', async () => {
    const s = setup();
    const saver = s.control.autosaver(vi.fn());
    await s.control.execute(command('/name', async (ctx, args) => {
      setSessionName(ctx.stats, args);
      return 'continue';
    }), s.ctx, 'A New Name');
    const model = await s.control.execute(command('/model', async (ctx, args) => {
      await setSessionModel(ctx.session.current, ctx.stats, args);
      return 'continue';
    }), s.ctx, 'opus');
    expect(model.session).toEqual({ model: 'opus', name: 'a-new-name' });
    saver.saveTurn('next', 'answer', { sessionId: 'fresh-provider', totalCostUsd: 0.1 });
    expect(saver.stats).toBe(s.stats);
    expect(s.stats).toMatchObject({ totalTurns: 1, name: 'a-new-name', model: 'opus', sessionId: 'stable-web' });
    expect(saveSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'opus', name: 'a-new-name', totalTurns: 1 }), 'stable-web');
  });

  it('injects the exact provider fast controller and retains thinking preference', async () => {
    const s = setup();
    await s.control.execute(command('/fast', async (ctx) => {
      expect(ctx.fastMode).toBe(s.controller);
      setSessionFast(ctx.fastMode!, 'on');
      setSessionThinking(ctx.stats, 'off');
      return 'continue';
    }), s.ctx, 'on');
    expect(s.controller.getPreference()).toBe('on');
    expect(s.stats.thinkingUi).toBe('off');
    expect(s.ctx.getFastModeContext?.()).toMatchObject({ executionPath: 'top-level', providerFamily: 'anthropic-direct' });
  });

  it('shared bare model handler reports names without opening a picker', async () => {
    const s = setup();
    await s.control.execute(infoCommands.find((c) => c.name === '/model')!, s.ctx, '');
    expect(s.writer.getChunks().join('')).toContain('Current model:');
    expect(s.writer.getChunks().join('')).toContain('Aliases:');
    expect(s.fake.setModel).not.toHaveBeenCalled();
  });

  it('shared compact handler emits text progress and runs hook before provider', async () => {
    const s = setup();
    await s.control.execute(coreCommands.find((c) => c.name === '/compact')!, s.ctx, '');
    expect(s.fake.hookRegistry.dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: 'PreCompact' }));
    expect(s.fake.compact).toHaveBeenCalledOnce();
    expect(s.writer.getChunks().join('')).toContain('Summarizing earlier turns...');
    expect(s.writer.getChunks().join('')).toContain('Nothing to compact');
  });

  it('mirrors post-clear sideband and elicitation records into stable projection', async () => {
    const s = setup();
    const originalSideband = s.fake.pushSidebandEvent;
    const originalElicitation = s.fake.recordLedgerElicitation;
    await s.control.execute(command('/clear'), s.ctx, '');
    s.session.pushSidebandEvent({ type: 'error', error: new Error('sideband error') });
    s.session.recordLedgerElicitation('request-1', { serverName: 'test', type: 'confirm', message: 'Approve?' });
    await s.control.close();
    const text = readFileSync(getSessionLedgerPath('stable-web'), 'utf8');
    expect(text).toContain('sideband error');
    expect(text).toContain('request-1');
    expect(originalSideband).toHaveBeenCalledOnce();
    expect(originalElicitation).toHaveBeenCalledOnce();
  });

  it('reports autosave failures once without losing the live turn', () => {
    const s = setup();
    const onError = vi.fn();
    vi.mocked(saveSession).mockImplementation(() => { throw new Error('disk'); });
    const saver = s.control.autosaver(onError);
    saver.saveTurn('one', '', undefined);
    saver.saveTurn('two', '', undefined);
    expect(onError).toHaveBeenCalledOnce();
    expect(s.stats.totalTurns).toBe(2);
    vi.mocked(saveSession).mockReset();
  });

  it('guards /exit when owner is undefined, matching /fork and /resume', async () => {
    const stats = createSessionStats('sonnet');
    const session = {
      sessionId: 'no-owner',
      reset: vi.fn(),
      waitForInitialization: vi.fn(),
      setModel: vi.fn(),
      pushSidebandEvent: vi.fn(),
      recordLedgerElicitation: vi.fn(),
    } as unknown as AgentSession;
    const control = new WebSessionControl('no-owner', session, stats, vi.fn());
    const writer = new BufferingWriter();
    const ctx = createWebSlashContext({ current: session }, stats, writer, '/tmp');
    const result = await control.execute(command('/exit'), ctx, '');
    expect(result.result).toBe('continue');
    expect(result.control).toBeUndefined();
    expect(writer.getChunks().join('')).toContain('exit not available');
  });
});
