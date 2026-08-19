/**
 * Shared shape passed from the Telegram session factory into its two
 * provider-specific branch builders.
 *
 * Contract: everything here is resolved ONCE by `create-session.ts` before the
 * provider branch is chosen — model routing, prompt layering, cwd, the trace
 * writer, and the MCP manager. The branch builders consume it and must not
 * re-resolve any of it, so the two providers cannot drift apart on inputs the
 * way the pre-split inlined branches did.
 */

import type { AgentSession } from '../agent/session.js';
import type { AgentConfig } from '../agent/types.js';
import type { MemoryStore } from '../agent/memory/index.js';
import type { WorkspaceStore } from '../agent/workspace/workspace-store.js';
import type { loadConfig } from '../cli/config.js';
import type { createTelegramTraceWriter } from './construct-session.js';
import type { loadTelegramMcpManager } from './mcp-session.js';

/** Bot-level resolved CLI config (the `loadConfig()` result). */
export type TelegramBotConfig = ReturnType<typeof loadConfig>;

/** Structurally exact writer/manager types, without importing their internals. */
export type TelegramTraceWriter = ReturnType<typeof createTelegramTraceWriter>;
export type TelegramMcpManager = Awaited<ReturnType<typeof loadTelegramMcpManager>>;

export interface TelegramSessionBuildContext {
  /** Per-chat session config handed in by `SessionManager`. */
  sessionConfig: AgentConfig;
  /** Bot-level config resolved once at startup. */
  config: TelegramBotConfig;
  /** Framework base + operator overlay, already layered (never substituted). */
  layeredBasePrompt: string | undefined;
  /** `sessionConfig.cwd ?? AFK_TELEGRAM_CWD`. */
  sessionCwd: string | undefined;
  /** Anthropic-only; undefined for OpenAI-routed sessions. */
  maxOutputTokens: number | undefined;
  /** Applies to BOTH providers via `resolveMaxToolIterations()`. */
  maxToolUseIterations: number | undefined;
  traceWriter: TelegramTraceWriter;
  mcpManager: TelegramMcpManager;
  /** Bot-global store shared across every chat's hook bundle. */
  memoryStore: MemoryStore;
  /** Bot-global workspace store; one SQLite per bot process, shared by all sessions. Undefined when AFK_WORKSPACE_DISABLED=1. */
  workspaceStore?: WorkspaceStore;
  /**
   * Telegram chat id for the originating session. Threaded from
   * `sessionConfig.telegramChatId` so the `TelegramBgResultNotifier` can
   * push background job notifications to the right chat in multi-chat setups.
   * Undefined when not set (falls back to bot-global notify targets).
   */
  chatId?: number;
  /**
   * Report the session the moment it is constructed.
   *
   * Invariant: the factory's catch block closes an already-constructed session
   * rather than merely disconnecting MCP. A branch builder can still throw
   * AFTER construction (grant seeding, path-approval wiring), so it must report
   * the session as soon as it exists — not on return — or that failure path
   * leaks a live session.
   */
  reportSession: (session: AgentSession) => void;
}
