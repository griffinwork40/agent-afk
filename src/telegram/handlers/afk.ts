/**
 * `/afk [on|off]` — toggle AFK (autonomous) mode for THIS chat's session.
 *
 * Telegram-host analogue of the REPL `/afk` (src/cli/afk-mode-toggle.ts). Flips
 * the chat session's permission mode to 'autonomous' (raised autonomy: works
 * without asking on reversible work) or back to 'default'. The afk-mode safety
 * gate — now registered on Telegram (see the hook-registry wiring in
 * src/telegram.ts) — enforces the ceiling and reads the session's live mode.
 *
 * SAFETY POSTURE (deliberately differs from the laptop REPL): on the persistent,
 * always-on Telegram host, high-risk / irreversible ops HARD-REFUSE
 * (afkPromptForApproval:false in the registry wiring) and are surfaced as an
 * Asking summary — they are NOT one-tap-approvable from a standing phone
 * surface. Decision record: docs/afk-telegram-native-host.md.
 *
 * Restart posture: the mode is runtime-only and NOT persisted — a bot restart
 * safe-degrades the chat back to 'default' (it never silently resumes autonomous
 * after a crash). Re-run /afk on to re-arm.
 */

import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { SessionManager } from '../session-manager.js';
import { formatError } from '../formatter.js';

type LogFn = (...args: unknown[]) => void;

const AFK_ON_COPY =
  '◐ AFK mode ON — I\'ll work autonomously on reversible tasks and report here. ' +
  'High-risk / irreversible ops are REFUSED (not one-tap approvable) and surfaced ' +
  'as an Asking summary for you to handle deliberately. Send /afk off to stop.';

const AFK_OFF_COPY = '○ AFK mode OFF — default permissions restored.';

export async function handleAfk(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply(formatError('Could not identify chat'));
    return;
  }

  const text = (ctx.message as Message.TextMessage).text ?? '';
  const arg = text.split(/\s+/).slice(1).join(' ').trim().toLowerCase();

  try {
    // getSession lazily constructs the chat's session if needed — which also
    // binds the hook-registry mode getter to it (src/telegram.ts), so the gate
    // observes the flip below on the very next tool call.
    const session = await sessionManager.getSession(chatId);
    const current = session.getSessionMetadata().permissionMode === 'autonomous';
    const desired = arg === 'on' ? true : arg === 'off' ? false : !current;

    if (desired === current) {
      await ctx.reply(desired ? '◐ AFK mode is already ON.' : '○ AFK mode is already OFF.');
      return;
    }

    await session.setPermissionMode(desired ? 'autonomous' : 'default');
    await ctx.reply(desired ? AFK_ON_COPY : AFK_OFF_COPY);
  } catch (error) {
    log('AFK toggle error:', error);
    await ctx.reply(formatError('Could not toggle AFK mode'));
  }
}
