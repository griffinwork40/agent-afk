/**
 * Tests for src/telegram/handlers/commands.ts — /name handler.
 *
 * Mirrors the CLI `/name` semantics: show the current name with no args; set
 * (slugified) with an arg; persist immediately once the conversation has a
 * recorded turn so `afk i --resume <name>` resolves it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'telegraf';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { handleName } from './commands.js';
import { SessionManager } from '../session-manager.js';
import type { IAgentSession, AgentConfig, SessionState } from '../../agent/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockAgentSession implements IAgentSession {
  state: SessionState = 'idle';
  closed = false;

  async sendMessage(content: string) {
    return { role: 'assistant' as const, content: `Echo: ${content}`, timestamp: new Date() };
  }
  async *getOutputStream() {
    yield { type: 'done' as const };
  }
  abort(_reason: string): void { /* IAgentSession mock no-op */ }
  async close() {
    this.closed = true;
  }
  async reset() {}
}

function makeCtx(text: string, chatId: number | null = 42) {
  const reply = vi.fn(async () => ({ message_id: 1 }));
  const ctx = {
    chat: chatId === null ? undefined : { id: chatId, type: 'private' as const },
    message: { text },
    reply,
  } as unknown as Context;
  return { ctx, reply };
}

function makeManager(testDir: string): SessionManager {
  return new SessionManager({
    dataDir: join(testDir, 'sessions'),
    apiKey: 'test-key',
    defaultModel: 'sonnet' as const,
    createSession: async (_config: AgentConfig) => new MockAgentSession(),
  });
}

// ---------------------------------------------------------------------------
// handleName
// ---------------------------------------------------------------------------

describe('handleName', () => {
  let testDir: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let log: ReturnType<typeof vi.fn>;
  let manager: SessionManager;

  beforeEach(() => {
    log = vi.fn();
    testDir = join(tmpdir(), `afk-name-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Isolate HOME so the shared session store (saveSession → ~/.afk) is a
    // throwaway dir — the persist path runs for the "after a turn" cases.
    originalHome = process.env['HOME'];
    tmpHome = join(tmpdir(), `afk-name-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env['HOME'] = tmpHome;
    manager = makeManager(testDir);
  });

  afterEach(async () => {
    await manager.closeAll().catch(() => {});
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
  });

  it('replies with an error when chat context is missing', async () => {
    const { ctx, reply } = makeCtx('/name foo', null);
    await handleName(ctx, manager, log);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatch(/identify chat/i);
  });

  it('with no args, shows the "no name set" hint when unset', async () => {
    const { ctx, reply } = makeCtx('/name');
    await handleName(ctx, manager, log);
    expect(reply.mock.calls[0]?.[0]).toMatch(/no name set/i);
  });

  it('with no args, shows the current name when one is set', async () => {
    manager.setSessionName(42, 'preset-name');
    const { ctx, reply } = makeCtx('/name');
    await handleName(ctx, manager, log);
    expect(reply.mock.calls[0]?.[0]).toContain('preset-name');
  });

  it('rejects a name that slugifies to nothing', async () => {
    const { ctx, reply } = makeCtx('/name @#$%');
    await handleName(ctx, manager, log);
    expect(reply.mock.calls[0]?.[0]).toMatch(/invalid name/i);
    expect(manager.getSessionName(42)).toBeUndefined();
  });

  it('sets the name and notes it saves on the first turn when no turns yet', async () => {
    const { ctx, reply } = makeCtx('/name fresh-start');
    await handleName(ctx, manager, log);
    expect(manager.getSessionName(42)).toBe('fresh-start');
    expect(reply.mock.calls[0]?.[0]).toMatch(/first turn/i);
    // No resume line before the first turn.
    expect(reply.mock.calls[0]?.[0]).not.toContain('afk interactive');
  });

  it('sets the name and shows the CLI resume command after a turn', async () => {
    // Seed a recorded turn so the name persists immediately.
    manager.recordTelegramTurn(42, 'do a thing', 'sure', { sessionId: 'sdk-name-42' });
    const { ctx, reply } = makeCtx('/name shipped-it');
    await handleName(ctx, manager, log);
    expect(manager.getSessionName(42)).toBe('shipped-it');
    const sent = reply.mock.calls[0]?.[0] as string;
    expect(sent).toContain('afk interactive');
    expect(sent).toContain('--resume shipped-it');
  });

  it('slugifies a multi-word name into a kebab-case slug', async () => {
    const { ctx } = makeCtx('/name My Cool Session');
    await handleName(ctx, manager, log);
    expect(manager.getSessionName(42)).toBe('my-cool-session');
  });

  it('strips the @botname suffix from the command token (group chats)', async () => {
    const { ctx, reply } = makeCtx('/name@my_bot grouped-name');
    await handleName(ctx, manager, log);
    expect(manager.getSessionName(42)).toBe('grouped-name');
    // A set-confirmation, not the "no name set" hint.
    expect(reply.mock.calls[0]?.[0]).toMatch(/named/i);
  });

  it('catch path: replies with redacted message when setSessionName throws, does not leak filesystem path', async () => {
    // Seed a recorded turn so setSessionName attempts the immediate persist.
    manager.recordTelegramTurn(42, 'turn for catch test', 'ok', { sessionId: 'sdk-catch' });

    // Force setSessionName to throw with an error that includes a filesystem path.
    vi.spyOn(manager, 'setSessionName').mockImplementation(() => {
      throw new Error('EACCES: permission denied, open \'/Users/secret/.afk/state/sessions/sdk-catch.json\'');
    });

    const { ctx, reply } = makeCtx('/name catch-me');
    await handleName(ctx, manager, log);

    // The reply must NOT expose the filesystem path or the raw error message.
    const sent = reply.mock.calls[0]?.[0] as string;
    expect(sent).not.toContain('/Users/secret');
    expect(sent).not.toContain('EACCES');
    expect(sent).not.toContain('.afk');
    // The reply must confirm the name was set (redacted, path-free).
    expect(sent).toMatch(/catch-me/);
    expect(sent).toMatch(/couldn't save/i);

    // The server-side log must still receive the full error object.
    expect(log).toHaveBeenCalledWith('Name set error:', expect.any(Error));
  });
});
