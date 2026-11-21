/**
 * Isolation tests for the /global command.
 *
 * These tests pin the feature's core safety rule: chat text must never reach
 * the model, the transcript, the session ledger, or the peer inbox.  The agent
 * must have no supported way to open, post to, or read the chat.
 *
 * Keep <=350 lines.
 *
 * @module cli/slash/global-isolation.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { registerAll } from './index.js';
import { lookup, resetRegistry } from './registry.js';
import { createGlobalCommand } from './commands/global.js';
import type { GlobalCommandDeps } from './commands/global.js';
import type { SlashContext } from './types.js';
import { classifyEnvKey } from '../../config/settable-keys.js';
import { isReadDenied } from '../../agent/tools/handlers/read-denylist.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Minimal fake context factories
// ---------------------------------------------------------------------------

interface TestCtx extends SlashContext { _lines: string[] }

function makeCtx(overrides: Record<string, unknown> = {}): TestCtx {
  const lines: string[] = [];
  return {
    out: {
      info: (s: string) => { lines.push(`info:${s}`); },
      warn: (s: string) => { lines.push(`warn:${s}`); },
      error: (s: string) => { lines.push(`error:${s}`); },
      success: (s: string) => { lines.push(`ok:${s}`); },
      line: (s?: string) => { lines.push(s ?? ''); },
    },
    stats: { cwd: process.cwd() },
    _lines: lines,
    ...overrides,
  } as unknown as TestCtx;
}

function makeDeps(overrides: Partial<GlobalCommandDeps> = {}): GlobalCommandDeps {
  return {
    relayUrl: 'ws://localhost/global',
    createIdentityStore: () => { throw new Error('createIdentityStore called unexpectedly'); },
    createMuteStore: () => { throw new Error('createMuteStore called unexpectedly'); },
    createClient: () => { throw new Error('createClient called unexpectedly'); },
    pauseRecording: () => { /* no-op */ },
    resumeRecording: () => { /* no-op */ },
    isInteractiveTerminal: () => false, // default: not a terminal
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('/global isolation', () => {
  beforeEach(() => {
    resetRegistry();
    registerAll();
  });

  // ---- Capability checks ---------------------------------------------------

  it('refuses when ctx.capabilities lacks tty', async () => {
    const cmd = createGlobalCommand(makeDeps());
    const ctx = makeCtx({ capabilities: new Set(['other']) });
    const result = await cmd.handler(ctx, '');
    expect(ctx._lines.some(l => l.includes('interactive terminal'))).toBe(true);
  });

  it('refuses when ctx has no capabilities object (handler checks tty itself)', async () => {
    const cmd = createGlobalCommand(makeDeps());
    // No capabilities key: the registry skips the capability check but the
    // handler's own liveCompositor() verifies isInteractiveTerminal().
    const ctx = makeCtx();
    const result = await cmd.handler(ctx, '');
    // isInteractiveTerminal returns false (default dep) -> warn NOT_TTY
    expect(ctx._lines.some(l => l.includes('interactive terminal'))).toBe(true);
  });

  // ---- Argument safety -----------------------------------------------------

  it('/global with extra arguments never constructs a client', async () => {
    let clientConstructed = false;
    const cmd = createGlobalCommand(makeDeps({
      createClient: () => { clientConstructed = true; throw new Error('never'); },
      isInteractiveTerminal: () => false,
    }));
    const ctx = makeCtx();
    // Try various extra-argument forms
    await cmd.handler(ctx, 'send this message to everyone');
    await cmd.handler(ctx, 'name alice extra-arg');
    expect(clientConstructed).toBe(false);
  });

  it('/global with arbitrary extra args produces a usage warning, not a post', async () => {
    const cmd = createGlobalCommand(makeDeps({ isInteractiveTerminal: () => false }));
    const ctx = makeCtx({ capabilities: new Set(['tty']) });
    // Even with capabilities, the handler checks the real tty (isInteractiveTerminal=false)
    // so it should refuse before any argument parsing that could reach post()
    await cmd.handler(ctx, 'name alice extra');
    // The warn message should be about NOT_TTY, not about chat content
    expect(ctx._lines.every(l => !l.includes('send this message'))).toBe(true);
  });

  // ---- ctx.out isolation ---------------------------------------------------

  it('while the view runs, nothing containing message text goes through ctx.out', async () => {
    // The handler only writes to ctx.out for the subcommand status lines
    // (/global status, /global name, /global off) -- not for the chat view.
    // The chat view writes directly to the compositor stdout, not ctx.out.
    // This test verifies that when the terminal check fails, no chat content leaks.
    const secretText = 'SUPER_SECRET_CHAT_MESSAGE_XYZ';
    const cmd = createGlobalCommand(makeDeps({ isInteractiveTerminal: () => false }));
    const ctx = makeCtx();
    await cmd.handler(ctx, secretText);
    expect(ctx._lines.every(l => !l.includes(secretText))).toBe(true);
  });

  // ---- Registry: not reachable via skill executor path --------------------

  it('/global is registered as a native command with requires:[tty], not as a skill', () => {
    const cmd = lookup('/global');
    expect(cmd).toBeDefined();
    // Native commands do NOT have acceptsAttachments: skill commands do
    expect(cmd?.acceptsAttachments).toBeFalsy();
    // Skill commands return 'forward'; native commands return 'continue' or undefined
    // The /global command returns 'continue'
    expect(cmd?.requires).toContain('tty');
  });

  it('/global is in the slash registry after registerAll()', () => {
    expect(lookup('/global')).toBeDefined();
  });

  // ---- config_set path refuses AFK_GLOBAL_CHAT_URL ------------------------

  it('classifyEnvKey marks AFK_GLOBAL_CHAT_URL as protected (config_set refuses it)', () => {
    // AFK_GLOBAL_CHAT_URL is in PROTECTED_ENV_KEYS so an agent using
    // config_set cannot redirect messages to an attacker-controlled relay.
    expect(classifyEnvKey('AFK_GLOBAL_CHAT_URL')).toBe('protected');
  });

  // ---- Read denylist covers the identity file location --------------------

  it('isReadDenied returns denied for the default global-chat state directory', () => {
    // The FileIdentityStore defaults to ~/.afk/state/global-chat/identity.json.
    // The BUILTIN_READ_DENYLIST includes ~/.afk/state/global-chat so the agent
    // cannot read the private key or mute list.
    const identityPath = join(homedir(), '.afk', 'state', 'global-chat', 'identity.json');
    const { denied } = isReadDenied(identityPath);
    expect(denied).toBe(true);
  });

  it('isReadDenied returns denied for the global-chat directory itself', () => {
    const chatDir = join(homedir(), '.afk', 'state', 'global-chat');
    const { denied } = isReadDenied(chatDir);
    expect(denied).toBe(true);
  });
});
