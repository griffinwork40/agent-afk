/**
 * Telegram bot integration for Agent AFK CLI
 * @module telegram
 */

export { TelegramBot } from './bot.js';
export type { BotOptions } from './bot.js';

export { SessionManager } from './session-manager.js';
export type { SessionManagerOptions } from './session-manager.js';

export {
  splitLongMessage,
  escapeMarkdown,
  formatError,
  formatWelcome,
  formatModelSwitch,
  formatClear,
  formatReset,
  formatCompact,
  formatCompactNoop,
} from './formatter.js';

export { isRateLimitError, isNetworkError } from './error-utils.js';

export { streamResponse } from './streaming.js';

export { parseAllowedChatIds, createAllowlistMiddleware } from './allowlist.js';
