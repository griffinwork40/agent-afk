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
import { makeDeferredParentProxy } from '../agent/session/deferred-parent-proxy.js';
import { pendingChildBillingStreams } from '../agent/session/manager-shutdown-config.js';
import { BackgroundAgentRegistry } from '../agent/background-registry.js';
import { TelegramBgResultNotifier } from './bg-result-notifier.js';
import {
  getDefaultSubagentModel,
  getApiKeyForModel,
} from '../cli/shared-helpers.js';
import type { TelegramTraceWriter } from './session-context.js';

export interface TelegramExecutorWiringOptions {
  /** API key for the session model. */
  apiKey: string | undefined;
  /** Session model id. */
  model: string;
  /** Raw base prompt (pre-assembly). Forwarded to children as their system prompt. */
  layeredBasePrompt: string | undefined;
  /** Bare operator overlay (no framework); reaches unnamed `agent` children (#3324). */
  operatorOverlay?: string;
  /** Session cwd (from `AFK_TELEGRAM_CWD` or `sessionConfig.cwd`). */
  sessionCwd: string | undefined;
  /** Trace writer for the session. */
  traceWriter: TelegramTraceWriter;
  /** Telegram chat id for background-job notifications. */
  chatId: number | undefined;
  /** Telegram topic thread id for background-job notifications. */
  threadId: number | undefined;
  /**
   * Optional idle-wake callback. When provided, it is wired as
   * `bgNotifier.onInjectable` so a settled background job automatically
   * synthesises a new Telegram turn instead of waiting for the next user
   * message. Mirrors the REPL's `tryAutoResume` / `onInjectable` path.
   * The callee (e.g. `MessageHandler.wakeIdleSession`) is responsible for
   * guarding against concurrent turns and wake loops.
   */
  onInjectable?: () => void;
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
  /** Wired into `AgentConfig.getPendingChildTerminalWrites` so seal() can await in-flight cancel emits (#3714). */
  getPendingChildTerminalWrites: AgentConfig['getPendingChildTerminalWrites'];
  getPendingChildBillingStreams?: AgentConfig['getPendingChildBillingStreams'];
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
    operatorOverlay,
    sessionCwd,
    traceWriter,
    chatId,
    threadId,
    onInjectable,
    wireExtras,
  } = opts;

  // -- Deferred parent proxy (session constructed after executors) -----------
  const { proxy: deferredParent, bind: bindParent } = makeDeferredParentProxy();

  // -- Background registry + notifier ---------------------------------------
  const backgroundRegistry = new BackgroundAgentRegistry(
    traceWriter ? { traceWriter } : {},
  );
  const bgNotifier = new TelegramBgResultNotifier(backgroundRegistry, chatId, threadId);
  // Wire the idle-wake hook when the caller provided one. Mirrors the REPL's
  // `bgResultNotifier.onInjectable = tryAutoResume` wiring in bootstrap-infra.ts.
  if (onInjectable !== undefined) {
    bgNotifier.onInjectable = onInjectable;
  }

  // -- wireExecutors --------------------------------------------------------
  // backgroundAutoWake: true when the idle-wake hook is wired — the model's
  // delivery note then says "woken automatically" (auto-wake) instead of
  // "with next user message" (next-message). Mirrors bootstrap-infra.ts.
  // backgroundAutoDeliver is always true on Telegram: TelegramBgResultNotifier
  // always buffers non-cancelled jobs (no AFK_BG_AUTO_DELIVER opt-out on this
  // surface), so `next-message` is always the floor even without the wake hook.
  const executors = wireExecutors({
    surface: 'telegram',
    parentSession: deferredParent,
    apiKey,
    model,
    managerParentModel: model,
    defaultSubagentModel: getDefaultSubagentModel(model),
    resolveApiKeyForModel: getApiKeyForModel,
    ...(layeredBasePrompt !== undefined ? { systemPrompt: layeredBasePrompt } : {}),
    ...(operatorOverlay !== undefined ? { operatorOverlay } : {}),
    ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
    ...(traceWriter !== null ? { traceWriter } : {}),
    backgroundRegistry,
    backgroundAutoWake: () => onInjectable !== undefined,
    backgroundAutoDeliver: () => true,
    ...wireExtras,
  });

  // -- Drain callback -------------------------------------------------------
  const drainSubagents: AgentConfig['drainSubagents'] = async (reason) => {
    bgNotifier.dispose();
    await backgroundRegistry.cancelAll();
    const result = await executors.rootManager.abortAllAndDrain(
      'session_end', 'user_signal', undefined, reason === 'reset',
    );
    executors.continuationRegistry.dispose();
    return result;
  };

  // -- Late-bind helper -----------------------------------------------------
  const bindSession = (session: AgentSession): void => {
    bindParent(session);
    executors.rootManager.setOnSubagentSucceeded((usage, costUsd) => {
      session.recordSubagentCompletion(usage, costUsd);
    });
    executors.composeExecutor.setOnSubagentSucceeded((usage, costUsd) => {
      session.recordSubagentCompletion(usage, costUsd);
    });
  };

  const getPendingChildTerminalWrites: AgentConfig['getPendingChildTerminalWrites'] =
    () => executors.rootManager.getPendingChildTerminalWrites();

  return {
    executors, backgroundRegistry, bgNotifier, drainSubagents, getPendingChildTerminalWrites, bindSession,
    getPendingChildBillingStreams: () => pendingChildBillingStreams(executors.rootManager, executors.composeExecutor),
  };
}
