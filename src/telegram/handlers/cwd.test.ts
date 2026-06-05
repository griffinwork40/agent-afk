/**
 * Tests for src/telegram/handlers/commands.ts — /cd handler + resolveCwdInput.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'telegraf';
import { promises as fs } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, resolve, isAbsolute } from 'path';

import { handleCwd, resolveCwdInput } from './commands.js';
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

function makeManager(testDir: string, botCwd?: string): SessionManager {
  const opts = {
    dataDir: join(testDir, 'sessions'),
    apiKey: 'test-key',
    defaultModel: 'sonnet' as const,
    createSession: async (_config: AgentConfig) => new MockAgentSession(),
    ...(botCwd !== undefined ? { botCwd } : {}),
  };
  return new SessionManager(opts);
}

// ---------------------------------------------------------------------------
// resolveCwdInput (pure)
// ---------------------------------------------------------------------------

describe('resolveCwdInput', () => {
  const base = '/tmp/base';

  it('returns homedir for bare `~`', () => {
    expect(resolveCwdInput('~', base)).toBe(homedir());
  });

  it('expands `~/foo` to $HOME/foo', () => {
    expect(resolveCwdInput('~/foo', base)).toBe(resolve(homedir(), 'foo'));
  });

  it('preserves absolute paths unchanged', () => {
    expect(resolveCwdInput('/etc', base)).toBe(resolve('/etc'));
  });

  it('resolves relative paths against base', () => {
    expect(resolveCwdInput('foo', base)).toBe(resolve(base, 'foo'));
    expect(resolveCwdInput('../sibling', base)).toBe(resolve(base, '../sibling'));
    expect(resolveCwdInput('./here', base)).toBe(resolve(base, './here'));
  });

  it('trims surrounding whitespace before resolving', () => {
    expect(resolveCwdInput('  ~  ', base)).toBe(homedir());
  });

  it('always returns an absolute path', () => {
    expect(isAbsolute(resolveCwdInput('foo', base))).toBe(true);
    expect(isAbsolute(resolveCwdInput('~/x', base))).toBe(true);
    expect(isAbsolute(resolveCwdInput('/abs', base))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleCwd
// ---------------------------------------------------------------------------

describe('handleCwd', () => {
  let testDir: string;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'afk-cd-test-'));
    log = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('replies with error when chat context is missing', async () => {
    const manager = makeManager(testDir);
    const { ctx, reply } = makeCtx('/cd /tmp', null);
    await handleCwd(ctx, manager, log);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatch(/identify chat/i);
  });

  it('with no args, shows "no override" when neither override nor botCwd set', async () => {
    const manager = makeManager(testDir);
    const { ctx, reply } = makeCtx('/cd');
    await handleCwd(ctx, manager, log);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatch(/no cwd override/i);
  });

  it('with no args, shows botCwd fallback when set', async () => {
    const manager = makeManager(testDir, testDir);
    const { ctx, reply } = makeCtx('/cd');
    await handleCwd(ctx, manager, log);
    expect(reply.mock.calls[0]?.[0]).toContain(testDir);
  });

  it('with no args, shows per-chat override when set', async () => {
    const manager = makeManager(testDir);
    await manager.setCwd(42, testDir);
    const { ctx, reply } = makeCtx('/cd');
    await handleCwd(ctx, manager, log);
    expect(reply.mock.calls[0]?.[0]).toContain(testDir);
  });

  it('trailing whitespace alone is treated as no-args', async () => {
    const manager = makeManager(testDir);
    const { ctx, reply } = makeCtx('/cd   ');
    await handleCwd(ctx, manager, log);
    expect(reply.mock.calls[0]?.[0]).toMatch(/no cwd override|current cwd/i);
  });

  it('persists an absolute path when the directory exists', async () => {
    const manager = makeManager(testDir);
    const target = await fs.mkdtemp(join(tmpdir(), 'afk-cd-target-'));
    try {
      const { ctx, reply } = makeCtx(`/cd ${target}`);
      await handleCwd(ctx, manager, log);
      expect(manager.getCwd(42)).toBe(target);
      expect(reply.mock.calls[0]?.[0]).toContain(target);
      expect(reply.mock.calls[0]?.[0]).toMatch(/fresh session/i);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it('resolves relative paths against the current effective cwd', async () => {
    // botCwd is testDir; relative path 'sub' should resolve to testDir/sub.
    const sub = join(testDir, 'sub');
    await fs.mkdir(sub);
    const manager = makeManager(testDir, testDir);
    const { ctx, reply } = makeCtx('/cd sub');
    await handleCwd(ctx, manager, log);
    expect(manager.getCwd(42)).toBe(sub);
    expect(reply.mock.calls[0]?.[0]).toContain(sub);
  });

  it('expands `~` and stores an absolute path', async () => {
    const manager = makeManager(testDir);
    const { ctx, reply } = makeCtx('/cd ~');
    await handleCwd(ctx, manager, log);
    // Assuming $HOME exists — should succeed.
    expect(manager.getCwd(42)).toBe(homedir());
    expect(reply.mock.calls[0]?.[0]).toContain(homedir());
  });

  it('refuses ENOENT paths without mutating state', async () => {
    const manager = makeManager(testDir);
    const bogus = join(testDir, 'does-not-exist');
    const { ctx, reply } = makeCtx(`/cd ${bogus}`);
    await handleCwd(ctx, manager, log);
    expect(manager.getCwd(42)).toBeUndefined();
    expect(reply.mock.calls[0]?.[0]).toMatch(/not found|does not exist/i);
  });

  it('refuses a path that is a file (not a directory)', async () => {
    const manager = makeManager(testDir);
    const filePath = join(testDir, 'a-file.txt');
    await fs.writeFile(filePath, 'hi');
    const { ctx, reply } = makeCtx(`/cd ${filePath}`);
    await handleCwd(ctx, manager, log);
    expect(manager.getCwd(42)).toBeUndefined();
    expect(reply.mock.calls[0]?.[0]).toMatch(/not a directory/i);
  });

  it('closes the existing session on successful setCwd', async () => {
    const manager = makeManager(testDir);
    const session = (await manager.getSession(42)) as MockAgentSession;
    const { ctx } = makeCtx(`/cd ${testDir}`);
    await handleCwd(ctx, manager, log);
    expect(session.closed).toBe(true);
  });
});
