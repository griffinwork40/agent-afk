/**
 * Shared Telegram session lifecycle helper.
 *
 * Extracted from the three Telegram provider branch builders
 * (`session-anthropic.ts`, `session-openai.ts`, `session-xai.ts`), which each
 * repeated ~45 lines of identical lifecycle tail:
 *
 *   1. `assembleSystemPrompt` from the layered base prompt + auto-routing flag
 *   2. `createTelegramAfkHookBundle` with the same four arguments
 *   3. `constructTelegramSession` with ~16 identical fields + a few
 *      provider-specific extras
 *   4. `attachMcpCleanup` wrapping
 *   5. Late-bind the hook-bundle mode getter to the live session
 *   6. `reportSession` + `seedPersistedGrants` + `wiring.bindSession`
 *
 * Callers pass only the genuinely divergent pieces:
 * - `provider`       — the fully-constructed ModelProvider for this branch
 * - `providerConfig` — provider-specific extra fields for `constructTelegramSession`
 *                      (e.g. `{ openaiBaseUrl }` for OpenAI, `{ xaiBaseUrl }` for xAI,
 *                      `{ baseUrl }` for Anthropic — omit the key when undefined)
 * - `ctx`            — the shared `TelegramSessionBuildContext`
 * - `wiring`         — the `TelegramExecutorWiring` already built by the caller
 *
 * @module telegram/session-lifecycle
 */

import { seedPersistedGrants } from '../agent/permissions-store.js';
import { assembleSystemPrompt } from '../agent/routing-directive.js';
import { createTelegramAfkHookBundle } from './afk-hook-bundle.js';
import { constructTelegramSession } from './construct-session.js';
import { attachMcpCleanup } from './mcp-session.js';
import type { AgentSession } from '../agent/session.js';
import type { AgentConfig } from '../agent/types.js';
import type { ModelProvider } from '../agent/provider.js';
import type { TelegramSessionBuildContext } from './session-context.js';
import type { TelegramExecutorWiring } from './wire-telegram-executors.js';

/**
 * Minimal grant-manager surface required by `seedPersistedGrants`. All three
 * Telegram providers (`AnthropicDirectProvider`, `OpenAICompatibleProvider`,
 * `XaiProvider`) implement these methods directly on the provider object.
 */
type GrantSeeding = {
  addReadRoot(absPath: string, source: 'slash' | 'tool'): void;
  addWriteRoot(absPath: string, source: 'slash' | 'tool'): void;
};

/**
 * Provider-specific extra fields forwarded verbatim into
 * `constructTelegramSession`. Each branch passes only its own fields; the rest
 * of the session config is shared and built here.
 *
 * All keys are optional: omit a key rather than setting it to `undefined` so
 * the conditional spread (`...(v !== undefined ? { k: v } : {})`) patterns
 * in the branch builders are unnecessary here — a key present with value
 * `undefined` is equivalent to absent for the downstream spread anyway, but
 * explicit omission is cleaner and matches the existing branch-builder style.
 */
export type ProviderSessionConfig = Pick<
  AgentConfig,
  'baseUrl' | 'openaiBaseUrl' | 'xaiBaseUrl'
>;

/**
 * Build, register, and return the AgentSession for a Telegram provider branch.
 *
 * Encapsulates the lifecycle steps that are byte-for-byte identical across all
 * three provider branches. The caller is responsible only for:
 *   1. Building `wiring` via `wireTelegramExecutors`
 *   2. Constructing the provider (with the wired executors)
 *   3. Calling this function with the assembled pieces
 *
 * The `provider` must expose a `getGrantManager()` method (or equivalent)
 * compatible with `seedPersistedGrants` — i.e. it must implement the same
 * grant-manager shape that `AnthropicDirectProvider`, `OpenAICompatibleProvider`,
 * and `XaiProvider` all implement.
 */
export function finalizeTelegramSession(
  provider: ModelProvider & GrantSeeding,
  providerConfig: ProviderSessionConfig,
  ctx: TelegramSessionBuildContext,
  wiring: TelegramExecutorWiring,
): AgentSession {
  const {
    sessionConfig,
    config,
    layeredBasePrompt,
    sessionCwd,
    maxOutputTokens,
    maxToolUseIterations,
    traceWriter,
    mcpManager,
    memoryStore,
    reportSession,
  } = ctx;

  // -- System-prompt assembly -----------------------------------------------
  // Identical across all three branches: apply auto-routing directives on top
  // of the raw layered base prompt. `typeof ... === 'string'` guard is load-
  // bearing: non-string prompts (SystemPromptFunction) bypass assembly.
  const telegramAutoRouting = config.autoRouting?.telegram ?? false;
  const systemPrompt = typeof layeredBasePrompt === 'string'
    ? assembleSystemPrompt(layeredBasePrompt, telegramAutoRouting, 'telegram')
    : layeredBasePrompt;

  // -- Hook bundle ----------------------------------------------------------
  // The AFK autonomous-safety registry must be built before the session so
  // its hookRegistry is available at construction time. The mode getter is
  // late-bound below (after `attachMcpCleanup`) via `sessionForMode`.
  let sessionForMode: AgentSession | undefined;
  const hookBundle = createTelegramAfkHookBundle({
    memoryStore,
    getSession: () => sessionForMode,
    cwd: sessionCwd,
    traceWriter,
  });

  // -- Session construction -------------------------------------------------
  // The ~16 shared fields are assembled here; provider-specific extras come
  // from `providerConfig` and are spread in (undefined values are absent from
  // the spread so they never shadow explicit config keys downstream).
  const session = attachMcpCleanup(constructTelegramSession({
    ...(sessionConfig.apiKey !== undefined ? { apiKey: sessionConfig.apiKey } : {}),
    model: sessionConfig.model,
    ...(sessionConfig.resume !== undefined ? { resume: sessionConfig.resume } : {}),
    ...(sessionConfig.sessionId !== undefined ? { sessionId: sessionConfig.sessionId } : {}),
    ...(sessionConfig.resumeHistory !== undefined
      ? { resumeHistory: sessionConfig.resumeHistory }
      : {}),
    ...(sessionConfig.resumeMessages !== undefined
      ? { resumeMessages: sessionConfig.resumeMessages }
      : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    maxTurns: 100,
    drainSubagents: wiring.drainSubagents,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxToolUseIterations !== undefined ? { maxToolUseIterations } : {}),
    // Provider-specific extras (baseUrl / openaiBaseUrl / xaiBaseUrl).
    // Only the keys present in providerConfig are spread; absent keys are
    // not forwarded so the session config stays clean.
    ...(providerConfig.baseUrl !== undefined
      ? { baseUrl: providerConfig.baseUrl }
      : {}),
    ...(providerConfig.openaiBaseUrl !== undefined
      ? { openaiBaseUrl: providerConfig.openaiBaseUrl }
      : {}),
    ...(providerConfig.xaiBaseUrl !== undefined
      ? { xaiBaseUrl: providerConfig.xaiBaseUrl }
      : {}),
    ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
    provider,
    hookRegistry: hookBundle.registry,
  }, { traceWriter }), mcpManager);

  // -- Late-bind + post-construction wiring ---------------------------------
  // Invariant from session-context.ts: report the session the moment it
  // exists — before grant seeding or any step that might throw — so the
  // factory's catch block can close it rather than leaking a live session.
  sessionForMode = session;
  reportSession(session);
  seedPersistedGrants(provider);
  wiring.bindSession(session);

  // Wire session-layer Stop dispatch. Telegram sessions are persistent per-chat
  // so `getHasNextTurn` is always true — the next user message delivers the
  // correction. `onStopInjectContext` queues the string via
  // `queueFrameworkContext` so it rides the next outbound user turn, mirroring
  // the REPL's `pendingStopInjection` delivery path.
  //
  // Permission mode: Telegram sessions run in 'default' or 'autonomous' (AFK)
  // depending on whether `/afk on` is active. The terminal-state gate is
  // autonomous-only, so it fires only when AFK mode is on. Shell hooks are off
  // unless `enableShellHooks` is true in afk.config.json.
  session.wireStopHook?.({
    getHasNextTurn: () => true,
    onStopInjectContext: (text) => { session.queueFrameworkContext(text); },
    // Blocked/timeout notices: Telegram does not render dim lines; swallow silently.
    onStopBlocked: () => undefined,
    onStopTimeout: () => undefined,
  });

  return session;
}
