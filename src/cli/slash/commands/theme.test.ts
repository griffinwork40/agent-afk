/**
 * Unit tests for the /theme slash command.
 *
 * The command resolves dark/light/auto, applies it to the live palette via
 * applyTheme(), repaints the active frame, and reports via ctx.out. These
 * tests verify dispatch, the no-arg report path, invalid-arg rejection, and
 * tolerance of a missing compositor. applyTheme mutates global palette state,
 * so each case resets to dark afterward.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { themeCmd } from './theme.js';
import { applyTheme, getActiveTheme } from '../../theme.js';
import type { SlashContext } from '../types.js';

function makeCtx() {
  const info = vi.fn();
  const success = vi.fn();
  const warn = vi.fn();
  const repaint = vi.fn();
  const ctx = {
    out: { info, success, warn },
    getCompositor: () => ({ repaint }),
  } as unknown as SlashContext;
  return { ctx, info, success, warn, repaint };
}

afterEach(() => applyTheme('dark'));

describe('/theme command', () => {
  it('/theme light → applies light, repaints, reports success, continues', async () => {
    const { ctx, success, repaint } = makeCtx();
    const result = await themeCmd.handler(ctx, 'light');
    expect(getActiveTheme()).toBe('light');
    expect(repaint).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledOnce();
    expect(result).toBe('continue');
  });

  it('/theme dark → applies dark (from a light start)', async () => {
    applyTheme('light');
    const { ctx } = makeCtx();
    await themeCmd.handler(ctx, 'dark');
    expect(getActiveTheme()).toBe('dark');
  });

  it('/theme auto → resolves to a concrete theme and notes the resolution', async () => {
    const { ctx, success } = makeCtx();
    await themeCmd.handler(ctx, 'auto');
    expect(['dark', 'light']).toContain(getActiveTheme());
    const msg = success.mock.calls[0][0] as string;
    expect(msg).toMatch(/auto/);
  });

  it('bare /theme → reports the active theme via info, no repaint, no swap', async () => {
    applyTheme('light');
    const { ctx, info, success, repaint } = makeCtx();
    const result = await themeCmd.handler(ctx, '');
    expect(info).toHaveBeenCalledOnce();
    expect((info.mock.calls[0][0] as string)).toMatch(/light/);
    expect(success).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
    expect(getActiveTheme()).toBe('light');
    expect(result).toBe('continue');
  });

  it('/theme <invalid> → warns, leaves theme unchanged, no repaint', async () => {
    const { ctx, warn, repaint } = makeCtx();
    const before = getActiveTheme();
    const result = await themeCmd.handler(ctx, 'plaid');
    expect(warn).toHaveBeenCalledOnce();
    expect(getActiveTheme()).toBe(before);
    expect(repaint).not.toHaveBeenCalled();
    expect(result).toBe('continue');
  });

  it('tolerates a missing compositor (getCompositor → null)', async () => {
    const success = vi.fn();
    const ctx = {
      out: { info: vi.fn(), success, warn: vi.fn() },
      getCompositor: () => null,
    } as unknown as SlashContext;
    const result = await themeCmd.handler(ctx, 'light');
    expect(getActiveTheme()).toBe('light');
    expect(success).toHaveBeenCalledOnce();
    expect(result).toBe('continue');
  });

  it('exposes correct metadata', () => {
    expect(themeCmd.name).toBe('/theme');
    expect(themeCmd.flags).toEqual(['dark', 'light', 'auto']);
  });
});
