import { Telegraf } from 'telegraf';
import type { IAgentSession } from '../../agent/types.js';

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
    const commands = [
      { command: 'start', description: 'Show welcome and command list' },
      { command: 'help', description: 'Show this command list' },
      { command: 'clear', description: 'Clear conversation history' },
      { command: 'compact', description: 'Compact conversation history' },
      { command: 'model', description: 'Switch Claude model (opus/sonnet/haiku)' },
      { command: 'cd', description: 'Show or change session working directory' },
      { command: 'name', description: 'Show or set the session name' },
      { command: 'sessions', description: 'List and switch between sessions' },
      { command: 'new', description: 'Start a new session (keeps the current one)' },
    ];

    // Add SDK slash commands
    if (meta.slashCommands?.length) {
      for (const cmd of meta.slashCommands) {
        const cmdName = cmd.replace(/^\//, '');
        commands.push({
          command: cmdName,
          description: `SDK command: ${cmdName}`,
        });
      }
    }

    // Add skills as commands
    if (meta.skills?.length) {
      for (const skill of meta.skills) {
        commands.push({
          command: skill,
          description: `Run ${skill} skill`,
        });
      }
    }

    // Register commands for this specific chat
    await bot.telegram.setMyCommands(commands, {
      scope: { type: 'chat', chat_id: chatId },
    });

    registeredCommandChats.add(chatId);
    log(`Registered ${commands.length} commands for chat ${chatId}`);
  } catch (error) {
    // Timeout or initialization error - commands will be limited to defaults
    log(`Could not register dynamic commands for chat ${chatId}:`, error);
  }
}
