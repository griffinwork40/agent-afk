/**
 * Stage 5: Telegram generic slash dispatch, menu derivation, and the
 * /clear ↔ SessionManager identity interplay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from 'telegraf';
import {
  classifyTelegramSlash, registryMenuDescriptors, telegramGateReason, needsIdleSession,
} from './slash-dispatch.telegram.js';
import { botCommandDescriptors, TELEGRAM_ONLY_COMMAND_DESCRIPTORS } from './bot.command-descriptors.js';
import { dispatchTelegramSlash, type SlashRunnerDeps } from './handlers/slash.js';
import { SessionManager } from './session-manager.js';
import { getElicitationRoute } from './elicitation-route-registry.js';
import type { IAgentSession } from '../agent/types.js';

describe('classifyTelegramSlash', () => {
  it('routes native shared commands with args', async () => {
    const cls = await classifyTelegramSlash('/model sonnet');
    expect(cls).toMatchObject({ kind: 'native', args: 'sonnet' });
    expect(cls.kind === 'native' && cls.cmd.name).toBe('/model');
  });

  it('normalizes /cmd@botname group mentions', async () => {
    const cls = await classifyTelegramSlash('/cost@afk_bot');
    expect(cls.kind === 'native' && cls.cmd.name).toBe('/cost');
  });

  it('refuses commands whose requirements Telegram cannot meet, with the reason', async () => {
    const cls = await classifyTelegramSlash('/editor');
    expect(cls).toMatchObject({ kind: 'refused', command: '/editor' });
    expect(cls.kind === 'refused' && cls.reason).toContain('requires terminal interaction');
    expect((await classifyTelegramSlash('/exit')).kind).toBe('refused');
    expect((await classifyTelegramSlash('/resume')).kind).toBe('refused');
  });

  it('suggests the nearest registered command for unknown input', async () => {
    expect(await classifyTelegramSlash('/cots')).toEqual({ kind: 'unknown', command: '/cots', suggestion: '/cost' });
    expect(await classifyTelegramSlash('/nope')).toMatchObject({ kind: 'unknown', command: '/nope' });
  });

  it('passes session-native skills/SDK commands through to the agent', async () => {
    expect(await classifyTelegramSlash('/my-skill go', ['my-skill'])).toEqual({ kind: 'passthrough' });
    expect(await classifyTelegramSlash('/sdk-cmd', ['/sdk-cmd'])).toEqual({ kind: 'passthrough' });
  });

  it('marks session-control commands as needing an idle route', async () => {
    const clear = await classifyTelegramSlash('/clear');
    const cost = await classifyTelegramSlash('/cost');
    expect(clear.kind === 'native' && needsIdleSession(clear.cmd)).toBe(true);
    expect(cost.kind === 'native' && needsIdleSession(cost.cmd)).toBe(false);
  });
});

describe('menu registration derived from the registry', () => {
  it('includes Telegram-runnable shared commands and excludes refused ones', async () => {
    const names = (await registryMenuDescriptors()).map((d) => d.command);
    for (const n of ['help', 'clear', 'compact', 'model', 'name', 'cost', 'usage', 'tokens']) expect(names).toContain(n);
    for (const n of ['editor', 'exit', 'resume', 'rewind', 'sh', 'theme']) expect(names).not.toContain(n);
    expect(names.every((n) => /^[a-z0-9_]{1,32}$/.test(n))).toBe(true);
    expect(telegramGateReason({ name: '/cost' })).toBeUndefined();
  });

  it('puts Telegram-only commands first, de-duplicated and capped at 100', async () => {
    const all = await botCommandDescriptors();
    expect(all.slice(0, TELEGRAM_ONLY_COMMAND_DESCRIPTORS.length).map((d) => d.command))
      .toEqual(TELEGRAM_ONLY_COMMAND_DESCRIPTORS.map((d) => d.command));
    expect(new Set(all.map((d) => d.command)).size).toBe(all.length);
    expect(all.length).toBeLessThanOrEqual(100);
    expect(all.find((d) => d.command === 'cost')?.description).toBe('Show total and per-turn cost');
  });
});

describe('/clear interplay with the chat SessionManager', () => {
  let sessionIdSeq = 0;
  function makeSession(): IAgentSession & { reset: ReturnType<typeof vi.fn> } {
    let sid = `sid-${++sessionIdSeq}`;
    return {
      state: 'idle',
      get sessionId() { return sid; },
      reset: vi.fn(async () => { sid = `sid-${++sessionIdSeq}`; }),
      close: vi.fn(async () => {}),
      getSessionMetadata: () => ({ slashCommands: [], skills: [] }),
      waitForInitialization: async () => ({}),
    } as unknown as IAgentSession & { reset: ReturnType<typeof vi.fn> };
  }

  let sm: SessionManager;
  let created: ReturnType<typeof makeSession>[];
  beforeEach(() => {
    created = [];
    sm = new SessionManager({
      apiKey: 'k',
      dataDir: mkdtempSync(join(tmpdir(), 'tg-clear-')),
      createSession: async () => { const s = makeSession(); created.push(s); return s; },
    });
  });

  function deps(): SlashRunnerDeps {
    return {
      sessionManager: sm, registeredCommandChats: new Set([5]), log: vi.fn(),
      isClaimed: () => false, reserveClaim: vi.fn(), releaseClaim: vi.fn(),
      enqueueSlash: vi.fn(() => 1), drainQueue: vi.fn(async () => {}),
    };
  }
  const ctx = (): Context => ({ reply: vi.fn(async () => ({})), sendChatAction: vi.fn(async () => true) }) as unknown as Context;

  it('resets in place: same session object, fresh id, stats/name cleared, cwd/model kept', async () => {
    const route = { chatId: 5 };
    const session = await sm.getSession(route);
    const oldId = session.sessionId!;
    expect(getElicitationRoute(oldId)).toEqual(route);
    sm.getStats(route).name = 'old-name';
    sm.getStats(route).totalTurns = 3;
    const d = deps();
    const c = ctx();

    expect(await dispatchTelegramSlash(d, c, route, '/clear')).toBe(true);

    expect(session.reset).toHaveBeenCalledOnce();
    expect(await sm.getSession(route)).toBe(session); // not replaced
    expect(created).toHaveLength(1);
    expect(session.sessionId).not.toBe(oldId);
    expect(sm.getSessionId(route)).toBe(session.sessionId);
    expect(getElicitationRoute(oldId)).toBeUndefined();
    expect(getElicitationRoute(session.sessionId!)).toEqual(route);
    expect(sm.getStats(route).totalTurns).toBe(0);
    expect(sm.getSessionName(route)).toBeUndefined();
    expect(d.registeredCommandChats.has(5)).toBe(false);
    expect(d.reserveClaim).toHaveBeenCalledOnce();
    expect(d.releaseClaim).toHaveBeenCalledOnce();
    expect((c.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('Conversation history cleared.');
  });

  it('drops a staged /sessions resume so the next turn starts fresh', async () => {
    const route = { chatId: 5 };
    await sm.getSession(route);
    (sm as unknown as { pendingResume: Map<string, string> }).pendingResume.set('5', 'old-session');
    await dispatchTelegramSlash(deps(), ctx(), route, '/clear');
    expect((sm as unknown as { pendingResume: Map<string, string> }).pendingResume.has('5')).toBe(false);
  });

  it('replaces the session when the in-place reset leaves it closed', async () => {
    const route = { chatId: 5 };
    const session = await sm.getSession(route);
    session.reset = vi.fn(async () => { (session as { state: string }).state = 'closed'; });
    const c = ctx();
    await dispatchTelegramSlash(deps(), c, route, '/clear');
    const next = await sm.getSession(route);
    expect(next).not.toBe(session);
    expect(created).toHaveLength(2);
  });

  it('queues /clear (no reset) while the route is claimed by a turn', async () => {
    const route = { chatId: 5 };
    const session = await sm.getSession(route);
    const d = { ...deps(), isClaimed: () => true };
    await dispatchTelegramSlash(d, ctx(), route, '/clear');
    expect(d.enqueueSlash).toHaveBeenCalledWith(route, expect.anything(), '/clear');
    expect(session.reset).not.toHaveBeenCalled();
  });
});
