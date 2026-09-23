/**
 * Shared Telegram session builder: common wiring + finalization.
 *
 * The three provider branch builders (`session-anthropic.ts`,
 * `session-openai.ts`, `session-xai.ts`) share the same scaffolding:
 *
 *   1. Call `wireTelegramExecutors` with provider-specific extras.
 *   2. Destructure the wired executors.
 *   3. Construct the provider (provider-specific — delegated to a factory callback).
 *   4. Call `finalizeTelegramSession`.
 *
 * This module handles steps 1, 2, and 4 so each branch only needs to cover
 * step 3 (the provider factory).
 *
 * @module telegram/session-builder
 */

import { wireTelegramExecutors } from './wire-telegram-executors.js';
import { finalizeTelegramSession } from './session-lifecycle.js';
import type { AgentSession } from '../agent/session.js';
import type { ModelProvider } from '../agent/provider.js';
import type { TelegramSessionBuildContext } from './session-context.js';
import type { ProviderSessionConfig } from './session-lifecycle.js';
import type { WireExecutorsOptions, WiredExecutors } from '../agent/session/wire-executors.js';

/** Grant-manager surface required by `seedPersistedGrants` (mirrors session-lifecycle.ts). */
type GrantSeeding = {
  addReadRoot(absPath: string, source: 'slash' | 'tool'): void;
  addWriteRoot(absPath: string, source: 'slash' | 'tool'): void;
};

/**
 * Inputs handed to the provider factory by {@link buildTelegramSession}.
 * The factory receives the wired executor trio so it can construct its
 * provider without re-running the executor scaffolding.
 */
export interface TelegramProviderFactoryInput {
  executors: WiredExecutors;
}

/**
 * Build, wire, and return a Telegram `AgentSession` for any provider branch.
 *
 * The caller supplies:
 * - `wireExtras`       — provider-specific keys forwarded to `wireTelegramExecutors`
 *                        (e.g. `{ baseUrl }`, `{ openaiBaseUrl }`, `{ xaiBaseUrl }`,
 *                        or `{ workspaceStore }`).
 * - `apiKey`           — resolved API key for the session. When omitted, falls back
 *                        to `ctx.sessionConfig.apiKey`. Anthropic branch resolves its
 *                        own fallback chain (`sessionConfig.apiKey ?? config.apiKey ?? ''`)
 *                        before calling here.
 * - `providerFactory`  — receives the wired executors; must return a fully-constructed
 *                        provider implementing `ModelProvider & GrantSeeding`.
 * - `providerConfig`   — provider-specific extras for `finalizeTelegramSession`
 *                        (the same keys: `baseUrl`, `openaiBaseUrl`, `xaiBaseUrl`).
 * - `ctx`              — shared `TelegramSessionBuildContext` from `create-session.ts`.
 *
 * The executor scaffolding (deferred parent proxy, background registry, bind step)
 * is provider-agnostic and assembled once here. `finalizeTelegramSession` then
 * handles the lifecycle tail identical across all branches.
 */
export function buildTelegramSession(opts: {
  ctx: TelegramSessionBuildContext;
  wireExtras?: Partial<WireExecutorsOptions>;
  apiKey?: string;
  providerFactory: (input: TelegramProviderFactoryInput) => ModelProvider & GrantSeeding;
  providerConfig: ProviderSessionConfig;
}): AgentSession {
  const { ctx, wireExtras, providerFactory, providerConfig } = opts;
  const {
    sessionConfig,
    layeredBasePrompt,
    sessionCwd,
    traceWriter,
    chatId,
    threadId,
  } = ctx;

  const wiring = wireTelegramExecutors({
    apiKey: opts.apiKey ?? sessionConfig.apiKey,
    model: sessionConfig.model,
    layeredBasePrompt,
    sessionCwd,
    traceWriter,
    chatId,
    threadId,
    wireExtras,
  });

  const provider = providerFactory({ executors: wiring.executors });

  return finalizeTelegramSession(provider, providerConfig, ctx, wiring);
}
