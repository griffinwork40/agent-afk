/**
 * Shared executor wiring for all three Telegram provider branches.
 *
 * Every Telegram session needs the same scaffolding regardless of provider:
 * a deferred parent proxy, a background registry + notifier, the
 * `wireExecutors` trio, a drain callback, and a late-bind step. This module
 * extracts that boilerplate so each branch (`session-anthropic.ts`,
 * `session-openai.ts`, `session-xai.ts`) focuses only on its
 * provider-specific construction.
 *
 * Invariant: the returned {@link TelegramExecutorWiring.bindSession} MUST be
 * called after the `AgentSession` is constructed. Until then the deferred
 * parent proxy resolves to stub values, and the subagent-success rollup is
 * unwired.
 */

import type { AgentSession } from '../agent/session/agent-session.js';
import type { AgentConfig } from '../agent/types.js';
import { wireExecutors, type WiredExecutors, type WireExecutorsOptions } from '../agent/session/wire-executors.js';
import { BackgroundAgentRegistry } from '../agent/background-registry.js';
import { TelegramBgResultNotifier } from './bg-result-notifier.js';
import {
  getDefaultSubagentModel,
  getApiKeyForModel,
} from '../cli/shared-helpers.js';
import type { SubagentExecutorContext } from '../agent/tools/subagent-executor.js';
import type { TelegramTraceWriter } from './session-context.js';

export interface TelegramExecutorWiringOptions {
  /** API key for the session model. */
  apiKey: string | undefined;
  /** Session model id. */
  model: string;
  /** Raw base prompt (pre-assembly). Forwarded to children as their system prompt. */
  layeredBasePrompt: string | undefined;
  /** Session cwd (from `AFK_TELEGRAM_CWD` or `sessionConfig.cwd`). */
  sessionCwd: string | undefined;
  /** Trace writer for the session. */
  traceWriter: TelegramTraceWriter;
  /** Telegram chat id for background-job notifications. */
  chatId: number | undefined;
  /** Telegram topic thread id for background-job notifications. */
  threadId: number | undefined;
  /**
   * Provider-specific extras spread into `wireExecutors`. Each branch passes
   * its own endpoint overrides (`baseUrl`, `openaiBaseUrl`, `xaiBaseUrl`) and
   * optional stores (`workspaceStore`) here.
   */
  wireExtras?: Partial<WireExecutorsOptions>;
}

export interface TelegramExecutorWiring {
  executors: WiredExecutors;
  backgroundRegistry: BackgroundAgentRegistry;
  bgNotifier: TelegramBgResultNotifier;
  /** Wired into `AgentConfig.drainSubagents` to cascade-abort children on close. */
  drainSubagents: AgentConfig['drainSubagents'];
  /**
   * Call after `new AgentSession(config)` to resolve the deferred parent proxy
   * and wire the subagent-success rollup.
   */
  bindSession: (session: AgentSession) => void;
}

/**
 * Build the shared executor + background + drain scaffolding for a Telegram
 * session. Provider-agnostic: works for Anthropic, OpenAI, and xAI branches.
 */
export function wireTelegramExecutors(
  opts: TelegramExecutorWiringOptions,
): TelegramExecutorWiring {
  const {
    apiKey,
    model,
    layeredBasePrompt,
    sessionCwd,
    traceWriter,
    chatId,
    threadId,
    wireExtras,
  } = opts;

  // -- Deferred parent proxy (session constructed after executors) -----------
  let boundSession: AgentSession | undefined;
  const deferredParent: SubagentExecutorContext['parentSession'] = {
    get sessionId() { return boundSession?.sessionId; },
    getInputStreamRef() { return boundSession?.getInputStreamRef?.() ?? { pushUserMessage: () => {} }; },
    get abortSignal() { return boundSession?.abortSignal ?? new AbortController().signal; },
    get hookRegistry() { return boundSession?.hookRegistry; },
  };

  // -- Background registry + notifier ---------------------------------------
  const backgroundRegistry = new BackgroundAgentRegistry(
    traceWriter ? { traceWriter } : {},
  );
  const bgNotifier = new TelegramBgResultNotifier(backgroundRegistry, chatId, threadId);

  // -- wireExecutors --------------------------------------------------------
  const executors = wireExecutors({
    surface: 'telegram',
    parentSession: deferredParent,
    apiKey,
    model,
    managerParentModel: model,
    defaultSubagentModel: getDefaultSubagentModel(model),
    resolveApiKeyForModel: getApiKeyForModel,
    ...(layeredBasePrompt !== undefined ? { systemPrompt: layeredBasePrompt } : {}),
    ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
    ...(traceWriter !== null ? { traceWriter } : {}),
    backgroundRegistry,
    ...wireExtras,
  });

  // -- Drain callback -------------------------------------------------------
  const drainSubagents: AgentConfig['drainSubagents'] = async (reason) => {
    bgNotifier.dispose();
    await backgroundRegistry.cancelAll();
    return executors.rootManager.abortAllAndDrain(
      'session_end', 'user_signal', undefined, reason === 'reset',
    );
  };

  // -- Late-bind helper -----------------------------------------------------
  const bindSession = (session: AgentSession): void => {
    boundSession = session;
    executors.rootManager.setOnSubagentSucceeded((usage, costUsd) => {
      session.recordSubagentCompletion(usage, costUsd);
    });
    executors.composeExecutor.setOnSubagentSucceeded((usage, costUsd) => {
      session.recordSubagentCompletion(usage, costUsd);
    });
  };

  return { executors, backgroundRegistry, bgNotifier, drainSubagents, bindSession };
}
