/**
 * Telegram per-chat session factory.
 *
 * Extracted from the `createSession` closure inside `src/telegram.ts`'s
 * `main()`, where it was 48% of the file and reachable only by booting a bot.
 * The bot-level values it used to capture from `main()`'s scope (resolved
 * config, framework base prompt, bot cwd, shared memory store) are now explicit
 * constructor arguments.
 *
 * Contract: this module resolves everything provider-agnostic — model routing,
 * token ceilings, prompt layering, cwd, trace writer, MCP manager — and then
 * delegates to exactly one branch builder. It owns the failure path for both.
 */

import { AgentSession } from '../agent/session.js';
import { resolveUnattendedLimits } from '../agent/unattended-limits.js';
import { providerForModel } from '../agent/providers/index.js';
import { resolveModelId } from '../agent/session/model-resolution.js';
import { getMaxOutputTokens, composeSystemPrompt } from '../cli/shared-helpers.js';
import type { AgentConfig } from '../agent/types.js';
import type { MemoryStore } from '../agent/memory/index.js';
import type { StateStore } from '../agent/state/state-store.js';
import { WorkspaceStore } from '../agent/workspace/workspace-store.js';
import { env } from '../config/env.js';
import { createTelegramTraceWriter } from './construct-session.js';
import { loadTelegramMcpManager } from './mcp-session.js';
import { pushIfConfigured } from './push.js';
import { isOpenAiRoutedProvider, isXaiRoutedProvider } from './credentials.js';
import { buildAnthropicTelegramSession } from './session-anthropic.js';
import { buildOpenAiTelegramSession } from './session-openai.js';
import { buildXaiTelegramSession } from './session-xai.js';
import type { TelegramBotConfig, TelegramSessionBuildContext } from './session-context.js';

export interface TelegramSessionFactoryOptions {
  /** Bot-level config resolved once at startup by `loadConfig()`. */
  config: TelegramBotConfig;
  /** Framework base prompt (`system-prompt.md`), resolved once. */
  frameworkBase: string | undefined;
  /** Bot-global cwd override (`AFK_TELEGRAM_CWD`), if any. */
  telegramCwd: string | undefined;
  /** Bot-global memory store shared by every chat's hook bundle. */
  memoryStore: MemoryStore;
  /** Bot-global state store for durable agent state. */
  stateStore?: StateStore;
  log?: (message: string) => void;
}

/**
 * Build the `createSession` callback handed to `TelegramBot`.
 */
export function createTelegramSessionFactory(
  options: TelegramSessionFactoryOptions,
): (sessionConfig: AgentConfig) => Promise<AgentSession> {
  const { config, frameworkBase, telegramCwd, memoryStore, stateStore } = options;
  const log = options.log ?? console.log;

  return async function createSession(sessionConfig: AgentConfig): Promise<AgentSession> {
    const fullModelId = resolveModelId(sessionConfig.model) ?? sessionConfig.model;
    log(`Creating session with model: ${sessionConfig.model} -> ${fullModelId}`);

    const sessionProviderName = providerForModel(fullModelId as string);
    // Historically called `isCodex` — this now means "is this an OpenAI-routed
    // session?" The openai-compatible provider replaced the legacy openai-codex
    // one in slice 5; the predicate stays for continuity of the downstream code
    // paths that branch on it. xAI is a separate branch (dual endpoints).
    const isOpenAiRouted = isOpenAiRoutedProvider(sessionProviderName);
    const isXaiRouted = isXaiRoutedProvider(sessionProviderName);
    // maxOutputTokens is Anthropic-oriented; skip for OpenAI + xAI Chat Completions.
    const maxOutputTokens = isOpenAiRouted || isXaiRouted ? undefined : getMaxOutputTokens();
    const { maxToolUseIterations, maxBudgetUsd } = resolveUnattendedLimits(
      env.AFK_MAX_TOOL_USE_ITERATIONS, env.AFK_MAX_BUDGET_USD, sessionConfig,
    );

    // System-prompt layering (mirrors chat.ts / bootstrap.ts): the framework
    // base is unconditional; the operator overlay (per-chat sessionConfig
    // override → afk.config.json / AFK.md / env via loadConfig) is appended on
    // top, never substituted for the base. Shared by both branches below, and
    // inherited by forked subagent / compose children so they carry the same base.
    const overlayPrompt = sessionConfig.systemPrompt ?? config.systemPrompt;
    const operatorOverlay = typeof overlayPrompt === 'string' && overlayPrompt.trim().length > 0
      ? overlayPrompt
      : undefined;
    const layeredBasePrompt = composeSystemPrompt(frameworkBase, operatorOverlay);

    const sessionCwd = sessionConfig.cwd ?? telegramCwd;
    // Invariant: the trace writer is created BEFORE loadTelegramMcpManager so
    // the MCP connect phase (mcp_server_start/done, mcp_connect_start/done) is
    // captured in the same session trace as the rest of the Telegram session.
    const traceWriter = createTelegramTraceWriter();
    const chatId = sessionConfig.telegramChatId;
    const threadId = sessionConfig.telegramThreadId;
    const mcpManager = await loadTelegramMcpManager(sessionCwd, {
      ...(traceWriter !== null ? { traceWriter } : {}),
      // Surface MCP server connection failures to the originating chat so the
      // operator learns about broken servers without having to check server logs.
      // Falls back to `console.warn` inside `loadTelegramMcpManager` when
      // `pushIfConfigured` returns null (no bot token / no resolvable chat id).
      sendWarning: chatId !== undefined
        ? (msg: string) => {
            void pushIfConfigured(msg, {
              target: chatId,
              ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
            });
          }
        : undefined,
    });

    // Declared before try so the catch/finally can call closeWorkspace() even
    // when WorkspaceStore construction itself throws (see #3588).
    let workspaceClosed = false;
    let workspaceStore: WorkspaceStore | undefined;
    const closeWorkspace = () => {
      if (workspaceClosed) return;
      workspaceClosed = true;
      workspaceStore?.close();
    };
    let returnedSession: AgentSession | undefined;

    try {
      // Per-chat isolation; the factory releases this owned store after session
      // teardown, never the bot-global memory/state stores passed in by the caller.
      // Constructed inside the try so that a SQLite-open failure triggers MCP
      // teardown via the catch rather than leaking the connected servers (#3588).
      workspaceStore = env.AFK_WORKSPACE_DISABLED === '1' ? undefined : new WorkspaceStore();
      const ctx: TelegramSessionBuildContext = {
        sessionConfig,
        config,
        layeredBasePrompt,
        ...(operatorOverlay !== undefined ? { operatorOverlay } : {}),
        sessionCwd,
        maxOutputTokens,
        maxToolUseIterations,
        maxBudgetUsd,
        traceWriter,
        mcpManager,
        memoryStore,
        ...(stateStore !== undefined ? { stateStore } : {}),
        workspaceStore,
        ...(sessionConfig.telegramChatId !== undefined ? { chatId: sessionConfig.telegramChatId } : {}),
        ...(sessionConfig.telegramThreadId !== undefined ? { threadId: sessionConfig.telegramThreadId } : {}),
        // Wire the pre-bound idle-wake hook injected by SessionManager.
        // When onInjectableForRoute was configured on the SessionManager,
        // buildAndRegisterSession placed the bound callback in
        // sessionConfig.telegramOnInjectable. Forward it into the session
        // context so wireTelegramExecutors can set bgNotifier.onInjectable.
        ...(sessionConfig.telegramOnInjectable !== undefined
          ? { onInjectable: sessionConfig.telegramOnInjectable }
          : {}),
        reportSession: (session) => {
          returnedSession = session;
          const close = session.close.bind(session);
          let closing: Promise<void> | undefined;
          session.close = () => closing ??= (async () => {
            try { await close(); } finally { closeWorkspace(); }
          })();
        },
      };

      if (isXaiRouted) {
        const xaiName = sessionProviderName === 'xai-oauth' ? 'xai-oauth' as const : 'xai' as const;
        return await buildXaiTelegramSession({ ...ctx, providerName: xaiName });
      }
      return isOpenAiRouted
        ? await buildOpenAiTelegramSession(ctx)
        : await buildAnthropicTelegramSession(ctx);
    } catch (error) {
      // Invariant: close the session if one was already constructed — closing it
      // also tears down its attached MCP manager. Only when no session exists
      // does the manager need disconnecting directly, or the connected servers
      // leak for the life of the bot process.
      try {
        if (returnedSession !== undefined) {
          await returnedSession.close().catch((e: unknown) => {
            log(`[create-session] warn: session close failed during recovery — ${String(e)}`);
          });
        } else if (mcpManager !== undefined) {
          await mcpManager.disconnectAll();
        }
      } finally {
        closeWorkspace();
      }
      throw error;
    }
  };
}
