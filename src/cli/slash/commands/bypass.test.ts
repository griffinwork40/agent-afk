/**
 * Unit tests for the /bypass slash command.
 *
 * /bypass toggles the session into/out of `'bypassPermissions'` — it resolves
 * on/off/bare-toggle intent against the current permissionMode, flips it via
 * session.setPermissionMode, mirrors stats.permissionMode, and repaints. These
 * tests verify dispatch + no-op suppression + the mutual-exclusivity replace.
 */

import { describe, it, expect, vi } from 'vitest';
import { bypassCmd } from './bypass.js';
import type { PermissionMode } from '../../../agent/types/sdk-types.js';
import type { SlashContext } from '../types.js';

function makeCtx(mode: PermissionMode): {
  ctx: SlashContext;
  setPermissionMode: ReturnType<typeof vi.fn>;
  repaint: ReturnType<typeof vi.fn>;
} {
  const setPermissionMode = vi.fn().mockResolvedValue(undefined);
  const repaint = vi.fn();
  const ctx = {
    stats: { permissionMode: mode },
    session: { current: { setPermissionMode } },
    ui: { repaintStatusLine: repaint },
    // `line` carries the ON notice (a cool "full-power" badge, not a red alarm);
    // `success` carries the OFF notice; `error` only fires on a toggle failure.
    out: { line: vi.fn(), success: vi.fn(), error: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, setPermissionMode, repaint };
}

describe('/bypass command', () => {
  it('/bypass on from default → enters bypassPermissions, mirrors stats, repaints, surfaces ON notice via line, continues', async () => {
    const { ctx, setPermissionMode, repaint } = makeCtx('default');
    const result = await bypassCmd.handler(ctx, 'on');
    expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(ctx.stats.permissionMode).toBe('bypassPermissions');
    expect(repaint).toHaveBeenCalled();
    // ON notice routes through the plain line channel (not error/✗) so it reads
    // as a "full-power" badge rather than a red alarm.
    expect((ctx.out.line as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((ctx.out.error as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result).toBe('continue');
  });

  it('/bypass off from bypassPermissions → restores default', async () => {
    const { ctx, setPermissionMode } = makeCtx('bypassPermissions');
    await bypassCmd.handler(ctx, 'off');
    expect(setPermissionMode).toHaveBeenCalledWith('default');
    expect(ctx.stats.permissionMode).toBe('default');
  });

  it('bare /bypass from default → toggles ON', async () => {
    const { ctx, setPermissionMode } = makeCtx('default');
    await bypassCmd.handler(ctx, '');
    expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('bare /bypass from bypassPermissions → toggles OFF', async () => {
    const { ctx, setPermissionMode } = makeCtx('bypassPermissions');
    await bypassCmd.handler(ctx, '');
    expect(setPermissionMode).toHaveBeenCalledWith('default');
  });

  it('/bypass on when already bypassPermissions → no-op (does not call setPermissionMode)', async () => {
    const { ctx, setPermissionMode } = makeCtx('bypassPermissions');
    const result = await bypassCmd.handler(ctx, 'on');
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(result).toBe('continue');
  });

  it('/bypass off when already default → no-op flip (no setPermissionMode), surfaces OFF notice', async () => {
    const { ctx, setPermissionMode } = makeCtx('default');
    await bypassCmd.handler(ctx, 'off');
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect((ctx.out.success as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('/bypass on from plan (mutual exclusivity) → replaces plan with bypassPermissions', async () => {
    const { ctx, setPermissionMode } = makeCtx('plan');
    await bypassCmd.handler(ctx, 'on');
    expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(ctx.stats.permissionMode).toBe('bypassPermissions');
  });

  it('leaves stats.permissionMode unchanged if setPermissionMode rejects', async () => {
    const { ctx, setPermissionMode } = makeCtx('default');
    setPermissionMode.mockRejectedValueOnce(new Error('session closing'));
    await bypassCmd.handler(ctx, 'on');
    expect(ctx.stats.permissionMode).toBe('default');
    expect((ctx.out.error as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
