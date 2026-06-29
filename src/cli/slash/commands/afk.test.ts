/**
 * Unit tests for the /afk slash command.
 *
 * The command resolves on/off/bare-toggle intent against the current
 * permissionMode and delegates the actual flip to `toggleAfkMode` (covered by
 * afk-mode-toggle.test.ts). These tests verify dispatch + no-op suppression.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const toggleAfkMode = vi.fn().mockResolvedValue(undefined);
vi.mock('../../afk-mode-toggle.js', () => ({
  toggleAfkMode: (...args: unknown[]) => toggleAfkMode(...args),
}));

import { afkCmd } from './afk.js';
import type { PermissionMode } from '../../../agent/types/sdk-types.js';
import type { SlashContext } from '../types.js';

function ctxWithMode(mode: PermissionMode): SlashContext {
  return { stats: { permissionMode: mode } } as unknown as SlashContext;
}

describe('/afk command', () => {
  beforeEach(() => toggleAfkMode.mockClear());

  it('/afk on from default → toggles ON, continues', async () => {
    const ctx = ctxWithMode('default');
    const result = await afkCmd.handler(ctx, 'on');
    expect(toggleAfkMode).toHaveBeenCalledWith(ctx, true);
    expect(result).toBe('continue');
  });

  it('/afk off from autonomous → toggles OFF, continues', async () => {
    const ctx = ctxWithMode('autonomous');
    const result = await afkCmd.handler(ctx, 'off');
    expect(toggleAfkMode).toHaveBeenCalledWith(ctx, false);
    expect(result).toBe('continue');
  });

  it('bare /afk from default → toggles ON', async () => {
    const ctx = ctxWithMode('default');
    await afkCmd.handler(ctx, '');
    expect(toggleAfkMode).toHaveBeenCalledWith(ctx, true);
  });

  it('bare /afk from autonomous → toggles OFF', async () => {
    const ctx = ctxWithMode('autonomous');
    await afkCmd.handler(ctx, '');
    expect(toggleAfkMode).toHaveBeenCalledWith(ctx, false);
  });

  it('/afk on when already autonomous → no-op (does not call toggle)', async () => {
    const ctx = ctxWithMode('autonomous');
    const result = await afkCmd.handler(ctx, 'on');
    expect(toggleAfkMode).not.toHaveBeenCalled();
    expect(result).toBe('continue');
  });

  it('entering AFK from plan mode replaces plan (toggles ON)', async () => {
    const ctx = ctxWithMode('plan');
    await afkCmd.handler(ctx, 'on');
    expect(toggleAfkMode).toHaveBeenCalledWith(ctx, true);
  });

  it('/afk off while in plan mode — warns, preserves plan mode, does NOT toggle', async () => {
    const warn = vi.fn();
    const ctx = { ...ctxWithMode('plan'), out: { warn } } as unknown as SlashContext;
    const result = await afkCmd.handler(ctx, 'off');
    // Must not clobber plan mode via toggleAfkMode
    expect(toggleAfkMode).not.toHaveBeenCalled();
    // Must return continue (no-op for the REPL loop)
    expect(result).toBe('continue');
    // Must surface a helpful, accurate message
    expect(warn).toHaveBeenCalledOnce();
    const msg: string = warn.mock.calls[0][0] as string;
    expect(msg).toMatch(/plan mode/i);
    expect(msg).toMatch(/\/plan off/i);
    // permissionMode must remain 'plan' (ctx was not mutated)
    expect((ctx as unknown as { stats: { permissionMode: string } }).stats.permissionMode).toBe('plan');
  });

  it('exposes correct metadata', () => {
    expect(afkCmd.name).toBe('/afk');
    expect(afkCmd.usage).toContain('/afk');
  });
});
