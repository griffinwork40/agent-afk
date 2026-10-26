/**
 * Telegram-surface SlashContext adapter: binds a chat route's live session and
 * accumulating SessionStats to the shared slash-command layer.
 */
import type { SlashContext, SessionStats, UiSurface } from '../cli/slash/types.js';
import type { AgentSession } from '../agent/session.js';
import type { IAgentSession } from '../agent/types.js';
import type { TelegramWriter } from './writer.telegram.js';
import { telegramCapabilities } from '../cli/slash/capabilities.js';

const NO_OP_UI: UiSurface = { clearScreen: () => {}, repaintStatusLine: () => {} };

/**
 * Contract: Telegram declares only `sessionControl`. No tty/readline,
 * compositor, soft-stop, ledger, requestResume or mcpManager is supplied;
 * commands needing those declare positive requirements and are refused by the
 * dispatcher before their handler runs.
 *
 * The per-chat session is an IAgentSession (the SessionManager's provider-
 * agnostic interface); every shared handler that runs here only touches
 * members IAgentSession also declares, so the structural cast is sound.
 */
export function createTelegramSlashContext(
  session: IAgentSession,
  stats: SessionStats,
  writer: TelegramWriter,
): SlashContext {
  return {
    capabilities: telegramCapabilities(),
    session: { current: session as unknown as AgentSession },
    stats,
    out: writer.asWriterInterface(),
    ui: NO_OP_UI,
  };
}
