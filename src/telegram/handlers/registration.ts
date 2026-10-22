import { Telegraf } from 'telegraf';
import type { IAgentSession } from '../../agent/types.js';
import { botCommandDescriptors, TELEGRAM_MENU_LIMIT } from '../bot.command-descriptors.js';

type LogFn = (...args: unknown[]) => void;

/**
 * Register commands for a specific chat including dynamic skills/commands
 * Called after session initialization to expose SDK-loaded skills as Telegram slash commands
 */
export async function registerChatCommands(
  bot: Telegraf,
  chatId: number,
  session: IAgentSession,
  registeredCommandChats: Set<number>,
  log: LogFn
): Promise<void> {
  // Skip if already registered for this chat
  if (registeredCommandChats.has(chatId)) {
    return;
  }

  try {
    // Wait for session to initialize and load skills/commands
    await Promise.race([
      session.waitForInitialization(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5000)
      ),
    ]);

    const meta = session.getSessionMetadata();

    // Build command list: static bot commands + dynamic skills/commands
    // Telegram-only + registry-derived shared commands (bot.command-descriptors.ts).
    const commands = await botCommandDescriptors();
    const seen = new Set(commands.map((c) => c.command));

    // Add SDK slash commands
    if (meta.slashCommands?.length) {
      for (const cmd of meta.slashCommands) {
        const cmdName = cmd.replace(/^\//, '');
        if (seen.has(cmdName)) continue;
        seen.add(cmdName);
        commands.push({
          command: cmdName,
          description: `SDK command: ${cmdName}`,
        });
      }
    }

    // Add skills as commands
    if (meta.skills?.length) {
      for (const skill of meta.skills) {
        if (seen.has(skill)) continue;
        seen.add(skill);
        commands.push({
          command: skill,
          description: `Run ${skill} skill`,
        });
      }
    }

    // Register commands for this specific chat (Telegram caps a scope at 100;
    // menu-invalid names such as namespaced skills are dropped).
    const menu = commands.filter((c) => /^[a-z0-9_]{1,32}$/.test(c.command)).slice(0, TELEGRAM_MENU_LIMIT);
    await bot.telegram.setMyCommands(menu, {
      scope: { type: 'chat', chat_id: chatId },
    });

    registeredCommandChats.add(chatId);
    log(`Registered ${menu.length} commands for chat ${chatId}`);
  } catch (error) {
    // Timeout or initialization error - commands will be limited to defaults
    log(`Could not register dynamic commands for chat ${chatId}:`, error);
  }
}
