import { Context } from 'telegraf';
import { formatWelcome } from '../formatter.js';

/**
 * Handle /start command - show welcome message
 */
export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(formatWelcome());
}
