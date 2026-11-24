import { describe, it, expect, vi } from 'vitest';
import { createGlobalCommand, type GlobalCommandDeps } from './global.js';
import type { SlashContext } from '../types.js';
import {
  FakeClient, FakeClock, FakeIdentity, FakeMutes, FakeStdin, FakeStdout, tick, ME,
} from '../../commands/interactive/global-chat-view.test-helpers.js';

function harness(over: Partial<GlobalCommandDeps> = {}, ctxOver: Partial<SlashContext> = {}, armed = true) {
  const out = { line: vi.fn(), raw: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const log: string[] = [];
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(log);
  const compositor = { stdin, stdout, isArmed: () => armed, suspendInput: vi.fn(), resumeInput: vi.fn(), repaint: vi.fn() };
  const identity = new FakeIdentity();
  const client = new FakeClient();
  const clock = new FakeClock();
  const createClient = vi.fn(() => client);
  const deps: GlobalCommandDeps = {
    relayUrl: 'wss://relay.example/chat',
    createIdentityStore: () => identity,
    createMuteStore: () => new FakeMutes(),
    createClient,
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    isInteractiveTerminal: () => true,
    clock,
    ...over,
  };
  const ctx = {
    out, getCompositor: () => compositor as never, suspendFooter: vi.fn(), resumeFooter: vi.fn(), ...ctxOver,
  } as unknown as SlashContext;
  const cmd = createGlobalCommand(deps);
  const all = (): string => [...out.info.mock.calls, ...out.warn.mock.calls, ...out.success.mock.calls, ...out.error.mock.calls].flat().join('\n');
  return { cmd, ctx, out, deps, identity, client, stdin, compositor, createClient, all, clock };
}

describe('/global command', () => {
  it('has the expected shape', () => {
    const { cmd } = harness();
    expect(cmd.name).toBe('/global');
    expect(cmd.requires).toEqual(['tty']);
  });

  it('refuses without a real terminal, compositor, or armed compositor', async () => {
    for (const h of [
      harness({ isInteractiveTerminal: () => false }),
      harness({}, { getCompositor: () => null }),
      harness({}, { getCompositor: undefined }),
      harness({}, {}, false),
      harness({}, { capabilities: new Set(['choose']) as never }),
    ]) {
      expect(await h.cmd.handler(h.ctx, '')).toBe('continue');
      expect(h.out.warn).toHaveBeenCalledWith('/global needs the interactive terminal REPL.');
      expect(h.createClient).not.toHaveBeenCalled();
    }
  });

  it('explains when no relay is configured', async () => {
    const h = harness({ relayUrl: undefined });
    await h.cmd.handler(h.ctx, '');
    expect(h.all()).toContain('AFK_GLOBAL_CHAT_URL');
    expect(h.compositor.suspendInput).not.toHaveBeenCalled();
  });

  it('rejects an invalid relay URL before terminal takeover', async () => {
    const h = harness({ relayUrl: 'ws://relay.example/v1/room/global' });
    await h.cmd.handler(h.ctx, '');
    expect(h.all()).toContain('AFK_GLOBAL_CHAT_URL is invalid');
    expect(h.compositor.suspendInput).not.toHaveBeenCalled();
  });

  it('opens the view with the relay url and returns after Esc', async () => {
    const h = harness();
    const p = h.cmd.handler(h.ctx, '');
    await tick();
    expect(h.createClient).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://relay.example/chat', identity: ME }));
    expect(h.ctx.suspendFooter).toHaveBeenCalled();
    h.stdin.type('\x1b'); h.clock.flush();
    expect(await p).toBe('continue');
    expect(h.ctx.resumeFooter).toHaveBeenCalled();
    expect(h.out.line).not.toHaveBeenCalled();
    expect(h.out.raw).not.toHaveBeenCalled();
  });

  it('name sets the display name and reports the daily limit', async () => {
    const h = harness();
    await h.cmd.handler(h.ctx, 'name neo');
    expect(h.identity.calls).toEqual(['rename:neo']);
    expect(h.all()).toContain('neo#abcd');
    h.identity.renameResult = { ok: false, code: 'name_change_too_soon', retryAfterMs: 7200_000 };
    await h.cmd.handler(h.ctx, 'name trinity');
    expect(h.all()).toContain('once a day');
    await h.cmd.handler(h.ctx, 'name');
    await h.cmd.handler(h.ctx, 'name two words');
    expect(h.out.warn).toHaveBeenCalledWith('Usage: /global name <name>');
    h.identity.identity = null;
    await h.cmd.handler(h.ctx, 'name neo');
    expect(h.all()).toContain('No chat identity yet');
  });

  it('status reports local state without connecting', async () => {
    const h = harness();
    await h.cmd.handler(h.ctx, 'status');
    expect(h.all()).toContain('enabled');
    expect(h.all()).toContain('me#abcd');
    expect(h.all()).toContain('Relay: configured');
    expect(h.createClient).not.toHaveBeenCalled();
    const h2 = harness({ relayUrl: undefined });
    h2.identity.identity = null;
    h2.identity.accepted = false;
    await h2.cmd.handler(h2.ctx, 'status');
    expect(h2.all()).toContain('off');
    expect(h2.all()).toContain('none yet');
    expect(h2.all()).toContain('not configured');
  });

  it('off clears consent and keeps the identity', async () => {
    const h = harness();
    await h.cmd.handler(h.ctx, 'off');
    expect(h.identity.calls).toEqual(['disable']);
    expect(h.identity.identity).not.toBeNull();
    expect(h.all()).toContain('identity is kept');
  });

  it('anything else prints usage and is never posted', async () => {
    const h = harness();
    for (const a of ['hello everyone', 'status now', 'off please', 'post hi']) {
      await h.cmd.handler(h.ctx, a);
    }
    expect(h.out.warn).toHaveBeenCalledTimes(4);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.client.posts).toEqual([]);
  });

  it('explains how to recover a corrupt or unreadable identity without overwriting it', async () => {
    const h = harness();
    h.identity.isNoticeAccepted = async () => { throw new Error('corrupt'); };
    await h.cmd.handler(h.ctx, '');
    expect(h.all()).toContain('Move it aside');
    expect(h.all()).toContain('Nothing was overwritten');
    expect(h.compositor.suspendInput).not.toHaveBeenCalled();
  });

  it('reports storage failures in one line', async () => {
    const h = harness();
    h.identity.disable = async () => { throw new Error('disk'); };
    await h.cmd.handler(h.ctx, 'off');
    expect(h.out.error).toHaveBeenCalledOnce();
    const h2 = harness();
    h2.identity.isNoticeAccepted = async () => { throw new Error('disk'); };
    await h2.cmd.handler(h2.ctx, '');
    expect(h2.out.error).toHaveBeenCalledWith(expect.stringContaining('Could not read the chat identity file'));
    expect(h2.compositor.suspendInput).not.toHaveBeenCalled();
  });
});
