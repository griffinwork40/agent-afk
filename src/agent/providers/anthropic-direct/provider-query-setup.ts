/**
 * First half of {@link AnthropicDirectProvider.query}: resolve credentials and
 * model, seed the session's shared roots, wire the dispatcher, and assemble the
 * prompt.
 *
 * Extracted verbatim from `provider-runtime.ts` (#824 split); the ordering
 * comments below are the load-bearing part and are preserved as written.
 *
 * @module agent/providers/anthropic-direct/provider-query-setup
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '../../types/config-types.js';
import type { ProviderQueryArgs } from '../../provider.js';
import { detectAuthMode } from './auth.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { resolveMaxTokens } from './resolve-params.js';
import { resolveQueryToken } from './query/token-resolution.js';
import { getClientFactory } from './provider-options.js';
import { setUpQueryClient } from './query/client-setup.js';
import { wireQueryDispatcher } from './query/dispatcher-wiring.js';
import { assembleQueryPrompt } from './query/prompt-assembly.js';
import { dumpIfEnabled } from '../../session/prompt-dump.js';
import { logStablePartsTokens } from '../shared/prompt-fragment-tokens.js';
import type { ProviderQueryContext } from './provider-context.js';
import { normalizeSystemPromptOverlay } from '../shared/system-prompt.js';
import { grantsWorkspacePrompt, grantsToolStrict } from '../shared/tool-grant.js';
import { deriveCredentialFromStore } from './provider-query-setup.credential.js';
import { loadClaudeCodeOauthToken } from '../../auth/keychain.js';

/** Everything the second half of `query()` needs from this one. */
export interface QuerySetupResult {
  client: Anthropic;
  authMode: import('./types.js').AuthMode;
  localMode: boolean;
  model: string;
  maxTokens: number;
  cwd: string;
  systemPrefix: Awaited<ReturnType<typeof setUpQueryClient>>['systemPrefix'];
  throttleQueue: ReturnType<typeof setUpQueryClient>['throttleQueue'];
  tokenRefresher: ReturnType<typeof setUpQueryClient>['tokenRefresher'];
  /** See {@link RetryLayerOptions.credentialFromStore}. */
  credentialFromStore: boolean;
  queryDispatcher: ReturnType<typeof wireQueryDispatcher>['queryDispatcher'];
  runtimeStateSource: ReturnType<typeof wireQueryDispatcher>['runtimeStateSource'];
  toolDefs: ReturnType<typeof wireQueryDispatcher>['toolDefs'];
  modelToolsFactory: ReturnType<typeof wireQueryDispatcher>['modelToolsFactory'];
  resolvedSessionId: ReturnType<typeof wireQueryDispatcher>['resolvedSessionId'];
  stableSystemPrefix: ReturnType<typeof assembleQueryPrompt>['stableSystemPrefix'];
  toolSystemAppend: ReturnType<typeof assembleQueryPrompt>['toolSystemAppend'];
}

/**
 * Resolve the user-supplied system prompt to a plain string.
 *
 * Delegates to `normalizeSystemPromptOverlay` (shared/system-prompt.ts) so
 * both providers use the same logic (#3261). Kept here for callers that
 * import it by this name.
 *
 * - `string` → returned as-is when non-empty.
 * - `{ type: 'preset', preset: 'claude_code', append?: string }` → the preset
 *   itself has no analog on the direct path, so we drop it and forward only
 *   the `append` portion (the user's explicit additions).
 * - everything else → `null`.
 */
export function resolveUserSystem(sp: AgentConfig['systemPrompt']): string | null {
  return normalizeSystemPromptOverlay(sp);
}

/** Run the credential/model/dispatcher/prompt half of `query()`. */
export function setUpQuerySession(
  ctx: ProviderQueryContext,
  args: ProviderQueryArgs,
  providerName: string,
  defaultModel: string,
): QuerySetupResult {
  const config = args.config;
  const { localMode, token } = resolveQueryToken(config);
  if (!token || token.length === 0) {
    throw new Error(
      `${providerName} provider requires config.apiKey (resolved from ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)`,
    );
  }
  const authMode = detectAuthMode(token);

  // Client + observability wiring (throttle mailbox, quota capture, tracing
  // fetch) and the OAuth token refresher that must reuse all three.
  const { client, throttleQueue, systemPrefix, tokenRefresher } = setUpQueryClient({
    config,
    token,
    authMode,
    localMode,
    factory: ctx.providerFactory ?? getClientFactory(),
    createClient: (opts) => new Anthropic(opts),
  });

  const userSystem = resolveUserSystem(config.systemPrompt);

  const model =
    typeof config.model === 'string' && config.model.length > 0
      ? (resolveModelId(config.model) ?? config.model)
      : defaultModel;

  const maxTokens = resolveMaxTokens(config, model);

  // Build a per-query dispatcher closed over the session's permissionMode
  // and cwd (fixes C2 env race + the process.cwd() leak: concurrent
  // sessions in different worktrees would otherwise all spawn bash/grep
  // against the host's process.cwd()). When the caller injected an
  // external dispatcher, use it as-is — external callers own their own
  // lifecycle.
  const permissionMode = config.permissionMode ?? 'default';
  // Track for getGrants() so the path-approval hook's allowAll stays in sync
  // with the per-query dispatcher's (both derive from this mode).
  ctx.setCurrentPermissionMode(permissionMode);

  // Initialise the shared root arrays on first query. Subsequent queries
  // reuse the same array references so /allow-dir grants survive across turns.
  // Route through ensureSharedRoots so _currentCwd is seeded on the first
  // query; the non-revocable guard in revokeRoot reads _currentCwd (Option A:
  // migrates with each setCwd call, so the active worktree root is protected).
  ctx.ensureSharedRoots(config.cwd);
  // Invariant: a cached provider instance is reused across `/model` swaps, and
  // ProviderRouter.buildInner injects the router's live cwd into each new
  // innerConfig — so `_currentCwd` left over from a PREVIOUS query can be older
  // than THIS query's `config.cwd`. Re-seed from the incoming config so the
  // awareness source never reports a checkout the rebuilt prompt and tools have
  // already left. Later `setCwd()` calls still win: they overwrite `_currentCwd`
  // after this point, and this only runs at query() entry.
  if (config.cwd) ctx.setCurrentCwd(config.cwd);
  // If the caller pre-supplied roots (e.g. forked subagent), prefer them on
  // the very first init only — ensureSharedRoots will have created defaults
  // we now overwrite with the explicit values.
  const sharedReadRoots = ctx.getSharedReadRoots();
  const sharedWriteRoots = ctx.getSharedWriteRoots();
  if (config.readRoots && sharedReadRoots && sharedReadRoots.length <= 1) {
    sharedReadRoots.length = 0;
    sharedReadRoots.push(...config.readRoots);
  }
  if (config.writeRoots && sharedWriteRoots && sharedWriteRoots.length <= 1) {
    sharedWriteRoots.length = 0;
    sharedWriteRoots.push(...config.writeRoots);
  }

  // Dispatcher + awareness source + presence, in that order. The
  // declare/capture/assign sequence for `queryDispatcher` lives entirely
  // inside this helper — see its module header; splitting it reintroduces
  // the stale-tool-list hazard (#824).
  const { queryDispatcher, runtimeStateSource, toolDefs, resolvedSessionId, modelToolsFactory } = wireQueryDispatcher({
    config,
    model,
    permissionMode,
    surface: ctx.surface,
    providerName,
    externalTools: ctx.externalTools,
    customToolSchemas: ctx.customToolSchemas,
    sharedReadRoots,
    sharedWriteRoots,
    // Live cwd: `_currentCwd` is re-seeded from this query's config above,
    // then `cwdDependentsFactory` updates it on every live-session re-anchor
    // (the deferred born-named `afk -w` worktree path) before the workspace
    // is re-read. Same `||` fall-through as the `cwd` const below, so the
    // `- Working directory:` and `- Workspace:` lines can never disagree.
    getCwd: () => ctx.getCurrentCwd() || config.cwd || process.cwd(),
    // Containment base for the dispatcher: the live re-anchored cwd or the
    // configured one, and NEVER the `process.cwd()` display fallback above
    // (undefined = unconfined; see DispatcherWiringArgs.getDispatcherCwd).
    getDispatcherCwd: () => ctx.getCurrentCwd() || config.cwd,
    getMcpTools: () => ctx.mcpManager?.getMcpTools() ?? [],
    getMcpServerStates: () => ctx.mcpManager?.getServerStates() ?? [],
    getSubagents: () =>
      ctx.subagentExecutor
        ? ctx.subagentExecutor.getSubagentsLite()
        : { active: [], backgroundJobs: [] },
    getMintedSessionId: () => ctx.getMintedSessionId(),
    setMintedSessionId: (v) => { ctx.setMintedSessionId(v); },
    getPresenceSessionId: () => ctx.getPresenceSessionId(),
    setPresenceSessionId: (v) => { ctx.setPresenceSessionId(v); },
    buildDispatcher: (mode, opts) => ctx.buildDispatcher(mode, opts),
  });

  const cwd = config.cwd || process.cwd();

  const { stableSystemPrefix, toolSystemAppend } = assembleQueryPrompt({
    config,
    cwd,
    surface: ctx.surface,
    readOnlyMemory: ctx.readOnlyMemory,
    readOnlyState: ctx.readOnlyState,
    // #4060: the section tells the model to call workspace_publish/query, so it
    // also needs both tools granted, not just a store.
    workspaceEnabled: ctx.workspaceStore !== undefined
      && grantsWorkspacePrompt((toolName) => grantsToolStrict(ctx.grantsTool, toolName)),
    // Pass the executor (not just a boolean) so assembleQueryPrompt can call
    // getManifestScope() for plugin/allowlist scoping. The truthiness gate is
    // preserved: manifest is built iff skillExecutor is truthy (same invariant
    // as the constructor's `if (opts.skillExecutor) schemas.push(skillTool)`).
    skillExecutor: ctx.skillExecutor ?? undefined,
    runtimeStateSource,
    userSystem,
    // Dynamic agent-type listing injected into the volatile system-prompt tail
    // rather than the tool description, preserving prefix-cache stability across
    // sessions that differ only in their agent sets (#4217).
    // Gate on the agent tool being both advertised (toolDefs: executor wired and
    // past the operator tool-toggle filter) and granted by this provider's
    // permissions, the same #4060 grant answer the workspace section uses, so
    // the prompt never lists agent types for a tool the model cannot call.
    //
    // Contract (parity with openai-compatible/index.ts): FAIL-CLOSED — an
    // embedder that omits `grantsTool` gets NO listing. The previous `?? true`
    // fallback was fail-open: it injected the listing whenever `grantsTool` was
    // absent, which could expose agent names the embedder never intended to grant.
    // Both providers now use the same rule: listing is emitted iff the tool is
    // present in the advertised set AND `grantsTool` explicitly returns true.
    agentTypeListing: toolDefs.some((t) => t.name === 'agent') && grantsToolStrict(ctx.grantsTool, 'agent')
      ? (ctx.subagentExecutor?.describeAgentTypeListing?.() ?? '')
      : '',
  });

  dumpQuerySetupPrompt({ args, config, model, maxTokens, toolSystemAppend });

  // Emit per-fragment token estimates to the witness trace (#4449). Read-path
  // only — the assembled prompt is never mutated by this call.
  logStablePartsTokens(config.traceWriter, stableSystemPrefix);

  // Contract: `credentialFromStore` is true IFF the session token was sourced
  // from the Claude Code OAuth keychain store (not an env var or slot-pinned
  // key). `tokenRefresher` presence alone is insufficient: every top-level
  // surface fills config.apiKey FROM the store (credential-resolver.ts:55-62),
  // so `tokenRefresher` is installed for EVERY oauth && !localMode session —
  // including ones whose token came from AFK_MODEL_<TIER>_API_KEY. We therefore
  // compare the live token against the store value. The store read uses the
  // 5 s in-process cache (keychain.ts:~24) so this is a cache hit on the same
  // value the RetryLayer constructor already read in this construction path.
  // If the store is unreadable, loadClaudeCodeOauthToken() returns undefined →
  // comparison yields false → conservative outcome (no auto-swap).
  const credentialFromStore = deriveCredentialFromStore(
    token,
    tokenRefresher !== undefined,
    loadClaudeCodeOauthToken,
  );

  return {
    client,
    authMode,
    localMode,
    model,
    maxTokens,
    cwd,
    systemPrefix,
    throttleQueue,
    tokenRefresher,
    credentialFromStore,
    queryDispatcher,
    runtimeStateSource,
    toolDefs,
    modelToolsFactory,
    resolvedSessionId,
    stableSystemPrefix,
    toolSystemAppend,
  };
}

/** Dump prompt debug info if AFK_DUMP_PROMPT is set (wired via --dump-prompt CLI flag). */
function dumpQuerySetupPrompt({
  args,
  config,
  model,
  maxTokens,
  toolSystemAppend,
}: {
  args: ProviderQueryArgs;
  config: AgentConfig;
  model: string;
  maxTokens: number;
  toolSystemAppend: string | null;
}): void {
  dumpIfEnabled({
    prompt: args.prompt,
    options: { model, maxTokens, system: toolSystemAppend },
    provenance: {
      systemPrompt: {
        source: config.systemPromptSource ?? 'none',
        shape: typeof config.systemPrompt === 'string'
          ? 'string'
          : Array.isArray(config.systemPrompt)
            ? 'string[]'
            : config.systemPrompt != null
              ? 'preset'
              : 'undefined',
        ...(typeof config.systemPrompt === 'string'
          ? { length: config.systemPrompt.length }
          : {}),
      },
      ...(config.apiKey ? { apiKey: { source: 'config' } } : {}),
    },
  });
}
