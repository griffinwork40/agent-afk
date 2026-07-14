/**
 * Tests for the Telegram `/afk` command handler (handlers/afk.ts).
 *
 * Verifies the toggle flips the chat session's permission mode via
 * setPermissionMode, is a no-op when already in the requested state, and
 * surfaces the hard-refuse safety posture in the ON copy.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'telegraf';
import { handleAfk } from './afk.js';
import type { SessionManager } from '../session-manager.js';

function makeCtx(text: string): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    chat: { id: 555 },
    message: { text },
    reply: (t: string) => {
      replies.push(t);
      return Promise.resolve({ message_id: replies.length });
    },
  };
  return { ctx: ctx as unknown as Context, replies };
}

function makeSession(mode: 'default' | 'autonomous') {
  let current = mode;
  const setPermissionMode = vi.fn(async (m: 'default' | 'autonomous') => {
    current = m;
  });
  const session = {
    getSessionMetadata: () => ({ permissionMode: current }),
    setPermissionMode,
  };
  return { session, setPermissionMode };
}

function makeSM(session: unknown): SessionManager {
  return { getSession: vi.fn(async () => session) } as unknown as SessionManager;
}

describe('handleAfk (/afk on Telegram)', () => {
  it('/afk on flips a default session to autonomous and surfaces the hard-refuse posture', async () => {
    const s = makeSession('default');
    const { ctx, replies } = makeCtx('/afk on');

    await handleAfk(ctx, makeSM(s.session), () => {});

    expect(s.setPermissionMode).toHaveBeenCalledWith('autonomous');
    const joined = replies.join('\n');
    expect(joined).toMatch(/AFK mode ON/i);
    // The ON copy must make clear high-risk ops are NOT one-tap approvable here.
    expect(joined).toMatch(/REFUSED/);
  });

  it('/afk off restores default', async () => {
    const s = makeSession('autonomous');
    const { ctx, replies } = makeCtx('/afk off');

    await handleAfk(ctx, makeSM(s.session), () => {});

    expect(s.setPermissionMode).toHaveBeenCalledWith('default');
    expect(replies.join('\n')).toMatch(/AFK mode OFF/i);
  });

  it('bare /afk toggles based on the current mode', async () => {
    const s = makeSession('default');
    const { ctx } = makeCtx('/afk');

    await handleAfk(ctx, makeSM(s.session), () => {});

    expect(s.setPermissionMode).toHaveBeenCalledWith('autonomous');
  });

  it('/afk on when already ON is a no-op with a notice (no setPermissionMode call)', async () => {
    const s = makeSession('autonomous');
    const { ctx, replies } = makeCtx('/afk on');

    await handleAfk(ctx, makeSM(s.session), () => {});

    expect(s.setPermissionMode).not.toHaveBeenCalled();
    expect(replies.join('\n')).toMatch(/already ON/i);
  });
});
