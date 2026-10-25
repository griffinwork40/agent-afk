import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capabilityReason, commandRequirements, missingCapabilities,
  webCapabilities, withCommandRequirements,
} from './capabilities.js';
import { dispatch, lookup, register, resetRegistry } from './registry.js';
import type { SlashCommand, SlashContext, SurfaceCapability } from './types.js';
import { createSessionStats } from './session-stats.js';
import { createWebSlashContext } from '../../web-server/slash-context.web.js';
import { BufferingWriter } from '../../web-server/writer.buffer.js';
import type { SessionRef } from '../../agent/session-ref.js';
import { FastModeController } from '../../agent/fast-mode.js';

const command = (name: string, requires?: readonly SurfaceCapability[]): SlashCommand => ({
  name, summary: 'test', handler: vi.fn(async () => 'continue' as const),
  ...(requires === undefined ? {} : { requires }),
});

afterEach(resetRegistry);

describe('positive surface capabilities', () => {
  it('treats new portable commands as requiring nothing', () => {
    const cmd = command('/portable');
    expect(commandRequirements(cmd)).toEqual([]);
    expect(withCommandRequirements(cmd)).toBe(cmd);
    expect(missingCapabilities(cmd, new Set())).toEqual([]);
  });

  it('adds migration requirements without mutating a definition', () => {
    const cmd = command('/editor');
    expect(withCommandRequirements(cmd).requires).toEqual(['tty']);
    expect(cmd.requires).toBeUndefined();
  });

  it('prefers explicit requirements, including a portable migration override', () => {
    expect(commandRequirements(command('/editor', []))).toEqual([]);
    expect(commandRequirements(command('/editor', ['shellJobs']))).toEqual(['shellJobs']);
  });

  it('checks all requirements rather than accepting one supported requirement', () => {
    expect(missingCapabilities(command('/test', ['tty', 'sessionControl']), webCapabilities()))
      .toEqual(['tty']);
  });

  it('does not advertise absent terminal or owner facilities on the web', () => {
    expect([...webCapabilities()]).toEqual(['sessionControl', 'choose', 'progress']);
    expect(webCapabilities()).not.toBe(webCapabilities());
  });

  it('gives every requirement a human-readable reason', () => {
    const capabilities: SurfaceCapability[] = [
      'tty', 'choose', 'progress', 'sessionControl', 'permissionMode', 'conversationRetry',
      'hostCredentials', 'shellJobs', 'consoleOutput',
    ];
    for (const capability of capabilities) expect(capabilityReason(capability)).toMatch(/requires/);
  });

  it('stores metadata in the registry and resolves aliases to the same requirement', () => {
    register({ ...command('/editor'), aliases: ['/ed'] });
    expect(lookup('/editor')?.requires).toEqual(['tty']);
    expect(lookup('/ed')).toBe(lookup('/editor'));
  });

  it('refuses unsupported commands before invoking a handler on explicit contexts', async () => {
    const cmd = command('/editor');
    register(cmd);
    const warn = vi.fn();
    const ctx = { capabilities: webCapabilities(), out: { warn } } as unknown as SlashContext;
    expect(await dispatch('/editor', ctx)).toEqual({ handled: true, result: 'continue' });
    expect(cmd.handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requires terminal'));
  });

  it('keeps legacy contexts working while allowing explicitly capable surfaces', async () => {
    const cmd = command('/editor');
    register(cmd);
    await dispatch('/editor', {} as SlashContext);
    await dispatch('/editor', { capabilities: new Set(['tty']) } as unknown as SlashContext);
    expect(cmd.handler).toHaveBeenCalledTimes(2);
  });

  it('forwards the owning session fast-mode integrations without replacing them', () => {
    const fastMode = new FastModeController();
    const getFastModeContext = vi.fn();
    const ctx = createWebSlashContext(
      {} as SessionRef, createSessionStats('sonnet'), new BufferingWriter(), '/project',
      { fastMode, getFastModeContext },
    );
    expect(ctx.fastMode).toBe(fastMode);
    expect(ctx.getFastModeContext).toBe(getFastModeContext);
  });

  it('retains the live stats object for web controls instead of mutating a copy', () => {
    const stats = createSessionStats('sonnet');
    const ctx = createWebSlashContext({} as SessionRef, stats, new BufferingWriter(), '/project');
    expect(ctx.stats).toBe(stats);
    expect(ctx.stats.cwd).toBe('/project');
    expect([...ctx.capabilities!]).toEqual(['sessionControl', 'choose', 'progress']);
    expect(ctx.getCompositor).toBeUndefined();
    ctx.stats.name = 'renamed';
    expect(stats.name).toBe('renamed');
  });
});
