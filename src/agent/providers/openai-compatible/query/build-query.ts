/**
 * Factory function for constructing an {@link OpenAICompatibleQuery}.
 *
 * Extracted from `query.ts` (350-code-line ceiling) — same extraction wave
 * as `turn-driver.ts` and `turn-iteration.ts`. This is the provider entrypoint;
 * tests use the class constructor directly via the `__setOpenAIClientFactory`
 * hook rather than this factory.
 *
 * @module agent/providers/openai-compatible/query/build-query
 */

import type { AgentConfig } from '../../../types/config-types.js';
import type { ProviderUserTurn } from '../../../provider.js';
import { resolveModelId } from '../../../session/model-resolution.js';
import { resolveOpenAIAuth, type AuthResolverDeps } from '../auth.js';
import type { ToolDispatcher } from '../../anthropic-direct/tool-dispatcher.js';
import { OpenAICompatibleQuery } from '../query.js';
import type { OpenAICompatibleQueryOptions } from './query-options.js';
import type { FastTierOptions } from './fast-tier-session.js';

/**
 * Resolve auth + construct a query. Provider entrypoint uses this; tests
 * use the constructor directly via the test-injection hook.
 */
export function buildQueryFromConfig(
  config: AgentConfig,
  promptStream: AsyncIterable<ProviderUserTurn>,
  options: {
    baseURL?: string;
    defaultHeaders?: Record<string, string>;
    toolDispatcher?: ToolDispatcher;
    onPermissionMode?: (mode: string) => void;
    onCwdChange?: (cwd: string) => void;
    systemPromptRebuildFactory?: (basePrompt: string | undefined) => string;
    mcpManager?: import('../../../mcp/index.js').McpManager;
    useResponsesApi?: boolean;
    /**
     * Optional env + fs injection point forwarded to `resolveOpenAIAuth`.
     * Tests pass a hermetic stub here to prevent reading real host credentials
     * (e.g. `~/.codex/auth.json`) from the developer's machine.
     */
    authDeps?: AuthResolverDeps;
    /**
     * Session id resolved by the calling provider.
     */
    sessionIdOverride?: string;
    /** Fast mode wiring from the provider (top-level sessions only). */
    fastTier?: FastTierOptions;
  } = {},
): OpenAICompatibleQuery {
  const auth = resolveOpenAIAuth(config.apiKey, options.authDeps, config.forceChatgptOAuth ?? false);
  const synthesizedSessionId =
    options.sessionIdOverride ??
    config.resume ??
    `openai-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rawModel = typeof config.model === 'string' ? config.model : 'gpt-4o-mini';
  const model = resolveModelId(rawModel) ?? rawModel;

  const opts: OpenAICompatibleQueryOptions = {
    auth,
    model,
    synthesizedSessionId,
    promptStream,
    config,
  };
  if (options.baseURL !== undefined) opts.baseURL = options.baseURL;
  if (options.defaultHeaders !== undefined) opts.defaultHeaders = options.defaultHeaders;
  if (options.toolDispatcher !== undefined) opts.toolDispatcher = options.toolDispatcher;
  if (options.onPermissionMode !== undefined) opts.onPermissionMode = options.onPermissionMode;
  if (options.onCwdChange !== undefined) opts.onCwdChange = options.onCwdChange;
  if (options.systemPromptRebuildFactory !== undefined) opts.systemPromptRebuildFactory = options.systemPromptRebuildFactory;
  if (options.mcpManager !== undefined) opts.mcpManager = options.mcpManager;
  if (options.useResponsesApi !== undefined) opts.useResponsesApi = options.useResponsesApi;
  if (config.traceWriter !== undefined) opts.traceWriter = config.traceWriter;
  if (options.fastTier !== undefined) opts.fastTier = options.fastTier;
  return new OpenAICompatibleQuery(opts);
}
