import { Context } from 'telegraf';
import { SessionManager } from '../session-manager.js';
import { formatHelp } from '../formatter.js';

/**
 * Handle /help command - show command list, optionally with SDK commands
 */
export async function handleHelp(
  ctx: Context,
  sessionManager: SessionManager
): Promise<void> {
  const chatId = ctx.chat?.id;
  let sdkCommands: string[] | undefined;
  const session = chatId ? sessionManager.getSessionIfExists(chatId) : undefined;
  if (session) {
    try {
      await Promise.race([
        session.waitForInitialization(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000)
        ),
      ]);
      const meta = session.getSessionMetadata();
      if (meta.slashCommands?.length) {
        sdkCommands = meta.slashCommands;
      }
    } catch {
      // No init yet or timeout; show bot commands only
    }
  }
  await ctx.reply(formatHelp(sdkCommands));
}
