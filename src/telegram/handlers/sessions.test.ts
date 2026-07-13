/**
 * Tests for src/telegram/handlers/sessions.ts — the /sessions switcher,
 * /new, and the afk:sw: inline-button switch callback.
 *
 * Uses a real SessionManager over a tmp HOME (the shared sidecar store) seeded
 * via recordTelegramTurn, mirroring the session-manager suite's harness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'telegraf';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { handleSessions, handleNew, handleSwitchCallback, SWITCH_CALLBACK_PREFIX } from './sessions.js';
import { SessionManager } from '../session-manager.js';
import { useUnsetAfkHome } from '../../__test-utils__/unset-afk-home.js';
import type { IAgentSession, AgentConfig, SessionState } from '../../agent/types.js';

class MockAgentSession implements IAgentSession {
  state: SessionState = 'idle';
  constructor(readonly sessionId?: string) {}
  async sendMessage(content: string) {
    return { role: 'assistant' as const, content: `Echo: ${content}`, timestamp: new Date() };
  }
  async *getOutputStream() { yield { type: 'done' as const }; }
  abort(_reason: string): void { /* no-op */ }
  async close() { /* no-op */ }
  async reset() { /* no-op */ }
}

interface InlineKeyboardReply {
  reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
  parse_mode?: string;
}

function makeCtx(chatId: number | null = 42) {
  const reply = vi.fn(async () => ({ message_id: 1 }));
  const ctx = {
    chat: chatId === null ? undefined : { id: chatId, type: 'private' as const },
    message: { text: '/sessions' },
    reply,
  } as unknown as Context;
  return { ctx, reply };
}

function makeCbCtx(data: string, chatId: number | null = 42) {
  const reply = vi.fn(async () => ({ message_id: 1 }));
  const editMessageText = vi.fn(async () => true);
  const ctx = {
    chat: chatId === null ? undefined : { id: chatId, type: 'private' as const },
    callbackQuery: { data },
    reply,
    editMessageText,
  } as unknown as Context;
  return { ctx, reply, editMessageText };
}

describe('session switcher handlers', () => {
  useUnsetAfkHome();

  let testDataDir: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let log: ReturnType<typeof vi.fn>;
  let manager: SessionManager;

  function makeManager(sessionId?: string): SessionManager {
    return new SessionManager({
      dataDir: testDataDir,
      apiKey: 'test-key',
      defaultModel: 'sonnet',
      createSession: async (_config: AgentConfig) => new MockAgentSession(sessionId),
    });
  }

  /** Seed two distinct resumable conversations for a chat (reset between). */
  async function seedTwo(chatId: number): Promise<void> {
    manager.recordTelegramTurn(chatId, 'alpha work', 'a', { sessionId: 'sdk-A' });
    await manager.resetSession(chatId);
    manager.recordTelegramTurn(chatId, 'beta work', 'b', { sessionId: 'sdk-B' });
  }

  beforeEach(() => {
    const entropy = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    testDataDir = join(tmpdir(), `afk-tg-sh-data-${entropy}`);
    originalHome = process.env['HOME'];
    tmpHome = join(tmpdir(), `afk-tg-sh-home-${entropy}`);
    process.env['HOME'] = tmpHome;
    log = vi.fn();
    manager = makeManager('sdk-live');
  });

  afterEach(async () => {
    await manager.closeAll().catch(() => {});
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    if (existsSync(testDataDir)) rmSync(testDataDir, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
  });

  describe('handleSessions', () => {
    it('replies with the no-sessions notice when the chat has none', async () => {
      const { ctx, reply } = makeCtx(700);
      await handleSessions(ctx, manager, log);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(String(reply.mock.calls[0]![0])).toContain('No saved sessions');
    });

    it('lists sessions with a tap-to-switch button per session', async () => {
      await seedTwo(701);
      const { ctx, reply } = makeCtx(701);
      await handleSessions(ctx, manager, log);

      const [body, opts] = reply.mock.calls[0] as [string, InlineKeyboardReply];
      expect(body).toContain('Your sessions');
      expect(opts.parse_mode).toBe('HTML');
      const rows = opts.reply_markup?.inline_keyboard ?? [];
      expect(rows).toHaveLength(2);
      const callbackData = rows.map((r) => r[0]!.callback_data).sort();
      expect(callbackData).toEqual([`${SWITCH_CALLBACK_PREFIX}sdk-A`, `${SWITCH_CALLBACK_PREFIX}sdk-B`]);
    });

    it('replies "Could not identify chat" when the update has no chat', async () => {
      const { ctx, reply } = makeCtx(null);
      await handleSessions(ctx, manager, log);
      expect(String(reply.mock.calls[0]![0])).toContain('Could not identify chat');
    });
  });

  describe('handleNew', () => {
    it('starts a fresh session and clears the command-registration cache when idle', async () => {
      manager.recordTelegramTurn(710, 'old convo', 'a', { sessionId: 'sdk-old' });
      const registered = new Set<number>([710]);
      const spy = vi.spyOn(manager, 'newSession');

      const { ctx, reply } = makeCtx(710);
      await handleNew(ctx, manager, registered, log);

      // Handler derives a General route (routeFromCtx) — bare chat, no topic.
      expect(spy).toHaveBeenCalledWith({ chatId: 710 });
      expect(registered.has(710)).toBe(false);
      expect(String(reply.mock.calls[0]![0])).toContain('fresh session');
      // Previous conversation is preserved as resumable.
      expect(manager.listChatSessions(710).map((s) => s.sessionId)).toContain('sdk-old');
    });

    it('refuses while the active session is mid-turn', async () => {
      const live = (await manager.getSession(711)) as MockAgentSession;
      live.state = 'processing';
      const spy = vi.spyOn(manager, 'newSession');

      const { ctx, reply } = makeCtx(711);
      await handleNew(ctx, manager, new Set<number>(), log);

      expect(spy).not.toHaveBeenCalled();
      expect(String(reply.mock.calls[0]![0])).toContain('current turn');
    });
  });

  describe('handleSwitchCallback', () => {
    it('switches to the tapped session and confirms', async () => {
      await seedTwo(720);
      const spy = vi.spyOn(manager, 'switchToSession');
      const { ctx, editMessageText, reply } = makeCbCtx(`${SWITCH_CALLBACK_PREFIX}sdk-A`, 720);

      await handleSwitchCallback(ctx, manager, log);

      expect(spy).toHaveBeenCalledWith({ chatId: 720 }, 'sdk-A');
      const confirmed = String(editMessageText.mock.calls[0]?.[0] ?? reply.mock.calls[0]?.[0] ?? '');
      expect(confirmed).toContain('Switched');
      // sdk-A is now the active conversation.
      expect(manager.listChatSessions(720).find((s) => s.sessionId === 'sdk-A')?.active).toBe(true);
    });

    it('reports not-found for an unknown target', async () => {
      await seedTwo(721);
      const { ctx, reply } = makeCbCtx(`${SWITCH_CALLBACK_PREFIX}sdk-nope`, 721);
      await handleSwitchCallback(ctx, manager, log);
      expect(String(reply.mock.calls[0]![0])).toContain('could no longer be found');
    });

    it('refuses while the active session is mid-turn', async () => {
      await seedTwo(722);
      const live = (await manager.getSession(722)) as MockAgentSession;
      live.state = 'streaming';
      const spy = vi.spyOn(manager, 'switchToSession');

      const { ctx, reply } = makeCbCtx(`${SWITCH_CALLBACK_PREFIX}sdk-A`, 722);
      await handleSwitchCallback(ctx, manager, log);

      expect(spy).not.toHaveBeenCalled();
      expect(String(reply.mock.calls[0]![0])).toContain('current turn');
    });

    it('ignores a callback with no matching prefix', async () => {
      const { ctx, reply, editMessageText } = makeCbCtx('afk:other:x', 723);
      await handleSwitchCallback(ctx, manager, log);
      expect(reply).not.toHaveBeenCalled();
      expect(editMessageText).not.toHaveBeenCalled();
    });
  });
});
