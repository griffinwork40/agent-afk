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
import { providerForModel } from '../agent/providers/index.js';
import { resolveModelId } from '../agent/session/model-resolution.js';
import { getMaxOutputTokens, getMaxToolUseIterations, composeSystemPrompt } from '../cli/shared-helpers.js';
import type { AgentConfig } from '../agent/types.js';
import type { MemoryStore } from '../agent/memory/index.js';
import { createTelegramTraceWriter } from './construct-session.js';
import { loadTelegramMcpManager } from './mcp-session.js';
import { isOpenAiRoutedProvider } from './credentials.js';
import { buildAnthropicTelegramSession } from './session-anthropic.js';
import { buildOpenAiTelegramSession } from './session-openai.js';
import type { TelegramBotConfig, TelegramSessionBuildContext } from './session-context.js';

export interface TelegramSessionFactoryOptions {
  /** Bot-level config resolved once at startup by `loadConfig()`. */
  config: TelegramBotConfig;
  /** Framework base prompt (`prompts/system-prompt.md`), resolved once. */
  frameworkBase: string | undefined;
  /** Bot-global cwd override (`AFK_TELEGRAM_CWD`), if any. */
  telegramCwd: string | undefined;
  /** Bot-global memory store shared by every chat's hook bundle. */
  memoryStore: MemoryStore;
  log?: (message: string) => void;
}

/**
 * Build the `createSession` callback handed to `TelegramBot`.
 */
export function createTelegramSessionFactory(
  options: TelegramSessionFactoryOptions,
): (sessionConfig: AgentConfig) => Promise<AgentSession> {
  const { config, frameworkBase, telegramCwd, memoryStore } = options;
  const log = options.log ?? console.log;

  return async function createSession(sessionConfig: AgentConfig): Promise<AgentSession> {
    const fullModelId = resolveModelId(sessionConfig.model) ?? sessionConfig.model;
    log(`Creating session with model: ${sessionConfig.model} -> ${fullModelId}`);

    const sessionProviderName = providerForModel(fullModelId as string);
    // Historically called `isCodex` — this now means "is this an OpenAI-routed
    // session?" The openai-compatible provider replaced the legacy openai-codex
    // one in slice 5; the predicate stays for continuity of the downstream code
    // paths that branch on it.
    const isOpenAiRouted = isOpenAiRoutedProvider(sessionProviderName);
    const maxOutputTokens = isOpenAiRouted ? undefined : getMaxOutputTokens();
    // Opt-in top-level tool-use-round ceiling (AFK_MAX_TOOL_USE_ITERATIONS).
    // Unlike maxOutputTokens (Anthropic-only here), this applies to BOTH
    // providers via resolveMaxToolIterations(), so it is NOT gated on the
    // provider. undefined = unlimited (no behavior change). No per-chat
    // override exists, so this is the env default only.
    const maxToolUseIterations = getMaxToolUseIterations();

    // System-prompt layering (mirrors chat.ts / bootstrap.ts): the framework
    // base is unconditional; the operator overlay (per-chat sessionConfig
    // override → afk.config.json / AFK.md / env via loadConfig) is appended on
    // top, never substituted for the base. Shared by both branches below, and
    // inherited by forked subagent / compose children so they carry the same base.
    const overlayPrompt = sessionConfig.systemPrompt ?? config.systemPrompt;
    const layeredBasePrompt = composeSystemPrompt(
      frameworkBase,
      typeof overlayPrompt === 'string' ? overlayPrompt : undefined,
    );

    const sessionCwd = sessionConfig.cwd ?? telegramCwd;
    // Invariant: the trace writer is created BEFORE loadTelegramMcpManager so
    // the MCP connect phase (mcp_server_start/done, mcp_connect_start/done) is
    // captured in the same session trace as the rest of the Telegram session.
    const traceWriter = createTelegramTraceWriter();
    const mcpManager = await loadTelegramMcpManager(sessionCwd, {
      ...(traceWriter !== null ? { traceWriter } : {}),
    });

    let returnedSession: AgentSession | undefined;
    const ctx: TelegramSessionBuildContext = {
      sessionConfig,
      config,
      layeredBasePrompt,
      sessionCwd,
      maxOutputTokens,
      maxToolUseIterations,
      traceWriter,
      mcpManager,
      memoryStore,
      reportSession: (session) => { returnedSession = session; },
    };

    try {
      return isOpenAiRouted
        ? await buildOpenAiTelegramSession(ctx)
        : await buildAnthropicTelegramSession(ctx);
    } catch (error) {
      // Invariant: close the session if one was already constructed — closing it
      // also tears down its attached MCP manager. Only when no session exists
      // does the manager need disconnecting directly, or the connected servers
      // leak for the life of the bot process.
      if (returnedSession !== undefined) {
        await returnedSession.close().catch(() => undefined);
      } else if (mcpManager !== undefined) {
        await mcpManager.disconnectAll();
      }
      throw error;
    }
  };
}
