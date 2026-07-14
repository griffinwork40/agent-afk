#!/usr/bin/env node
/**
 * Telegram bot entry point using the provider-neutral AgentSession.
 *
 * Auth matrix (matches the CLI exactly via `loadCredential()`):
 *   - Claude models:
 *       1. `ANTHROPIC_API_KEY` env var
 *       2. `CLAUDE_CODE_OAUTH_TOKEN` env var
 *       3. macOS Keychain entry `Claude Code-credentials` (set by
 *          `claude setup-token`, populated whenever Claude Code signs in).
 *      Token shape (`sk-ant-oat01-...` vs. `sk-ant-api...`) is detected by
 *      `detectAuthMode` in the `anthropic-direct` provider and routes the
 *      token to either OAuth bearer auth or `x-api-key` header auth.
 *      Per-request 401 refresh + write-back is owned by the provider via
 *      `tokenRefresher` (see `src/agent/providers/anthropic-direct/index.ts`).
 *
 *   - Codex models:  OPENAI_API_KEY / CODEX_API_KEY, or existing
 *                    `codex login` state on disk.
 *
 * Usage:
 * 1. Set TELEGRAM_BOT_TOKEN in .env (get from @BotFather).
 * 2. Either set ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN in the env, or
 *    sign in once with `afk login` / `claude setup-token`.
 * 3. Set AFK_TELEGRAM_ALLOWED_CHAT_IDS to your numeric chat ID.
 * 4. Run: npm run telegram
 */

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { env } from './config/env.js';
import { checkVersionDrift, decideVersionDriftAction } from './telegram/version-check.js';
import { TelegramBot } from './telegram/bot.js';
import { parseAllowedChatIds } from './telegram/allowlist.js';
import { validateBotToken } from './telegram/setup-wizard.js';
import { AgentSession } from './agent/session.js';
import { constructTelegramSession, createTelegramTraceWriter } from './telegram/construct-session.js';
import { createTelegramAfkHookBundle } from './telegram/afk-hook-bundle.js';
import { seedPersistedGrants } from './agent/permissions-store.js';
import { MemoryStore } from './agent/memory/index.js';
import { providerForModel, AnthropicDirectProvider, OpenAICompatibleProvider } from './agent/providers/index.js';
import { detectAuthMode } from './agent/providers/anthropic-direct/auth.js';
import { loadConfig, loadCredential } from './cli/config.js';
import { getEnvConfigPath } from './paths.js';
import { assembleSystemPrompt } from './agent/routing-directive.js';
import { resolveModelId } from './agent/session/model-resolution.js';
import { getDefaultSubagentModel, getMaxOutputTokens, getMaxToolUseIterations, getApiKeyForModel, loadSystemPrompt, composeSystemPrompt } from './cli/shared-helpers.js';
import { topLevelSurfaceAllowedTools } from './agent/tools/top-level-allowlist.js';
import type { AgentConfig, AgentModelInput } from './agent/types.js';
import { SubagentManager } from './agent/subagent.js';
import { SubagentExecutor } from './agent/tools/subagent-executor.js';
import { SkillExecutor } from './agent/tools/skill-executor.js';
import { ComposeExecutor } from './agent/tools/compose-executor.js';
import { createChildProviderFactory, createChildSkillExecutorFactory } from './agent/tools/nesting.js';
import { loadAgentRegistry } from './agent/agents/index.js';
import { discoverPluginAgents } from './agent/tools/skill-bridge.js';
import { attachMcpCleanup, loadTelegramMcpManager } from './telegram/mcp-session.js';

// Capture version once at module load. Used by checkVersionDrift on each stats tick.
// One level up from dist/ reaches project root where package.json lives.
// In Vitest (tsx transform), import.meta.url points to src/telegram.ts → '..' = project root.
let DAEMON_VERSION = 'unknown';
try {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (pkg.version) DAEMON_VERSION = pkg.version;
} catch {
  console.warn('⚠️ [daemon] Could not read package.json at startup — version drift check disabled.');
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error('❌ Configuration error:', (error as Error).message);
    process.exit(1);
  }

  // Framework base prompt (`prompts/system-prompt.md`, inlined at publish-build).
  // Resolved once here and layered under the operator overlay per session below,
  // so Telegram sessions carry the same unconditional base as chat / REPL.
  const frameworkBase = loadSystemPrompt();

  const providerName = providerForModel(config.model as string);

  if (providerName === 'openai-compatible' || providerName === 'openai-codex') {
    const openaiKey = env.OPENAI_API_KEY || env.CODEX_API_KEY;
    if (openaiKey) {
      console.log('📝 Using OPENAI_API_KEY / CODEX_API_KEY for OpenAI auth');
    } else {
      // The openai-compatible provider also reads ~/.codex/auth.json when
      // it contains an API key (not ChatGPT OAuth). Surface that path here
      // so the operator knows what the resolver will try.
      console.log('📝 Will attempt API key from ~/.codex/auth.json (run `afk provider auth diagnose` for details)');
    }
  } else {
    // Resolve credential via the same path the CLI uses: env vars first,
    // then the macOS keychain (Claude Code credentials). This avoids the
    // historical bug where the bot's manual env-var ladder didn't see
    // tokens stashed in the keychain by `claude setup-token`.
    const credential = loadCredential();
    if (!credential || credential.length === 0) {
      console.error('❌ Claude models require ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.');
      console.error('   Set one in your environment, run `afk login`, or sign in to Claude Code.');
      process.exit(1);
    }

    // Stash into the env var that matches the token shape so downstream
    // code (including the provider's per-request 401 refresher) sees a
    // consistent signal. The provider re-checks shape internally via
    // detectAuthMode — this is just for log clarity and any code path
    // that reads env directly.
    const authMode = detectAuthMode(credential);
    if (authMode === 'oauth') {
      process.env['CLAUDE_CODE_OAUTH_TOKEN'] = credential;
      console.log('📝 Using CLAUDE_CODE_OAUTH_TOKEN for Anthropic auth (OAuth, auto-refresh on 401)');
    } else {
      process.env['ANTHROPIC_API_KEY'] = credential;
      console.log('📝 Using ANTHROPIC_API_KEY for Anthropic auth');
    }
    // Make sure config.apiKey reflects the resolved credential so child
    // sessions threaded through createSession see the same token.
    config.apiKey = credential;
  }

  // Telegram-specific config (TELEGRAM_BOT_TOKEN, AFK_TELEGRAM_ALLOWED_CHAT_IDS,
  // TELEGRAM_VERBOSE, TELEGRAM_DATA_DIR) treats the user-scope config file as
  // authoritative when present, overriding any matching shell env var. This is
  // the inverse of dotenv's standard override:false rule and is intentional
  // here: these are operator-managed config values, not CI-injected credentials.
  // Shell envs that disagree are almost always accidental drift from an old
  // project `.env` that got exported into the parent shell — exactly the trap
  // that bit this repo's first end-to-end test. Operators who explicitly want
  // a shell override can edit the file via `afk telegram setup`.
  //
  // Anthropic credentials are NOT in this list — those keep dotenv's standard
  // shell-wins rule because CI commonly injects ANTHROPIC_API_KEY.
  applyTelegramFileOverrides(getEnvConfigPath());

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('❌ Error: TELEGRAM_BOT_TOKEN environment variable is required');
    console.error('\nHow to get a bot token:');
    console.error('  1. Open Telegram and search for @BotFather');
    console.error('  2. Send /newbot and follow the instructions');
    console.error('  3. Run: afk telegram setup');
    process.exit(1);
  }

  const allowedChatIds = parseAllowedChatIds(
    env.AFK_TELEGRAM_ALLOWED_CHAT_IDS,
    console.warn
  );
  if (allowedChatIds.size === 0) {
    console.error('❌ Error: AFK_TELEGRAM_ALLOWED_CHAT_IDS must list at least one chat ID');
    console.error('\nThis is an allowlist that gates who can message the bot.');
    console.error('Run `afk telegram setup` to set it interactively, or set it manually:');
    console.error('  AFK_TELEGRAM_ALLOWED_CHAT_IDS=123456789,-100987654321');
    process.exit(1);
  }

  // Validate the token via getMe BEFORE handing it to Telegraf. This
  // catches: revoked tokens, typo'd tokens, network issues, and most
  // importantly surfaces the *resolved bot identity* so the operator
  // sees which bot they're actually running — the single most useful
  // piece of operational data, hidden behind DEBUG=telegraf:* otherwise.
  console.log('🔎 Validating bot token...');
  const identity = await validateBotToken(botToken);
  if (!identity) {
    console.error('❌ Error: TELEGRAM_BOT_TOKEN was rejected by Telegram (getMe failed)');
    console.error('   The token may be revoked, malformed, or your network may be unreachable.');
    console.error('   Re-run `afk telegram setup` to refresh it.');
    process.exit(1);
  }
  const handle = identity.username ? `@${identity.username}` : identity.firstName;

  console.log('');
  console.log(`🤖 Starting Agent AFK Telegram Bot as ${handle} (id ${identity.id})`);
  console.log(`📡 Model: ${config.model} · Provider: ${providerName}`);
  console.log(`🔒 Allowlist: ${allowedChatIds.size} chat ID(s)`);

  const sharedMemoryStore = new MemoryStore();

  // Optional working-directory override for every bot-spawned session.
  // When set, all per-chat AgentSessions (and their forked subagents)
  // operate in this directory rather than the bot process's
  // `process.cwd()`. Use this to point the bot at a specific repo or
  // worktree without changing cwd before launch.
  const telegramCwd = env.AFK_TELEGRAM_CWD;

  const bot = new TelegramBot({
    botToken,
    apiKey: config.apiKey ?? '',
    dataDir: env.TELEGRAM_DATA_DIR || './data/telegram-sessions',
    defaultModel: config.model as AgentModelInput,
    verbose: env.TELEGRAM_VERBOSE === 'true',
    allowedChatIds,
    // Only meaningful for the Anthropic provider — the Codex adapter
    // ignores settingSources at construction time.
    settingSources: ['user', 'project'],
    // Bot-global cwd fallback used by SessionManager when no per-chat
    // override is set via /cd. Per-session `data.cwd` takes precedence.
    ...(telegramCwd !== undefined && telegramCwd.length > 0
      ? { botCwd: telegramCwd }
      : {}),
    createSession: async (sessionConfig: AgentConfig) => {
      const fullModelId = resolveModelId(sessionConfig.model) ?? sessionConfig.model;
      console.log(`Creating session with model: ${sessionConfig.model} -> ${fullModelId}`);

      const sessionProviderName = providerForModel(fullModelId as string);
      // Historically called `isCodex` — the variable now means "is this an
      // OpenAI-routed session?" The openai-compatible provider replaced the
      // legacy openai-codex one in slice 5; the boolean stays named for
      // continuity of the downstream code paths that branch on it.
      const isCodex =
        sessionProviderName === 'openai-compatible' || sessionProviderName === 'openai-codex';
      const maxOutputTokens = isCodex ? undefined : getMaxOutputTokens();
      // Opt-in top-level tool-use-round ceiling (AFK_MAX_TOOL_USE_ITERATIONS).
      // Unlike maxOutputTokens (Anthropic-only here), this applies to BOTH
      // providers via resolveMaxToolIterations(), so it is NOT gated by isCodex.
      // undefined = unlimited (no behavior change). No per-chat override exists,
      // so this is the env default only.
      const maxToolUseIterations = getMaxToolUseIterations();

      // System-prompt layering (mirrors chat.ts / bootstrap.ts): the framework
      // base is unconditional; the operator overlay (per-chat sessionConfig
      // override → afk.config.json / AFK.md / env via loadConfig) is appended
      // on top, never substituted for the base. Shared by both the Anthropic
      // and Codex branches below, and inherited by forked subagent / compose
      // children so they carry the same base.
      const overlayPrompt = sessionConfig.systemPrompt ?? config.systemPrompt;
      const layeredBasePrompt = composeSystemPrompt(
        frameworkBase,
        typeof overlayPrompt === 'string' ? overlayPrompt : undefined,
      );

      const sessionCwd = sessionConfig.cwd ?? telegramCwd;
      // Create the trace writer before loadTelegramMcpManager so the MCP
      // connect phase (mcp_server_start/done, mcp_connect_start/done) is
      // captured in the same session trace as the rest of the Telegram session.
      const telegramTraceWriter = createTelegramTraceWriter();
      const mcpManager = await loadTelegramMcpManager(sessionCwd, {
        ...(telegramTraceWriter !== null ? { traceWriter: telegramTraceWriter } : {}),
      });
      let returnedSession: AgentSession | undefined;
      try {
        let directProvider;
        if (!isCodex) {
        let boundSession: AgentSession | undefined;
        const telegramApiKey = sessionConfig.apiKey ?? config.apiKey ?? '';
        const telegramBaseUrl = config.baseUrl;
        // OpenAI-compatible endpoint (distinct from telegramBaseUrl, which is
        // Anthropic-only) — threaded for parity with chat.ts's cliConfig.openaiBaseUrl wiring.
        const telegramOpenaiBaseUrl = sessionConfig.openaiBaseUrl ?? config.openaiBaseUrl;
        // Inherit configured-or-host cwd so forked subagents stay in the
        // same working tree as the parent session — important when the
        // bot is pointed at a worktree via AFK_TELEGRAM_CWD.
        const rootManager = new SubagentManager({
          apiKey: telegramApiKey,
          // Parent model → provider, so the fork-time credential fallback never
          // crosses the provider boundary (see SubagentManager.parentProvider).
          parentModel: sessionConfig.model,
          ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
          ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
          // Witness layer: manager-level writer so `agent`-tool forks (which
          // never set config.traceWriter) emit subagent_lifecycle events and
          // hand the writer to their handles. Mirrors bootstrap.ts / chat.ts.
          ...(telegramTraceWriter !== null ? { traceWriter: telegramTraceWriter } : {}),
          // Origin attribution: thread the surface so forked `agent`-tool
          // children inherit origin 'telegram' (not 'unknown') via
          // forkSubagent's parentSurface fill. Mirrors farm.ts.
          surface: 'telegram',
        });

        const deferredParent = {
          get sessionId() { return boundSession?.sessionId; },
          getInputStreamRef() { return boundSession?.getInputStreamRef?.() ?? { pushUserMessage: () => {} }; },
          get abortSignal() { return boundSession?.abortSignal ?? new AbortController().signal; },
          // Live registry so forked subagents resolve it via forkSubagent's
          // parent fallback (SubagentStart/Stop + shadow-verify nudge).
          get hookRegistry() { return boundSession?.hookRegistry; },
        };

        // Pass openaiBaseUrl so OpenAI-routed children point at the configured
        // local shim instead of the default api.openai.com (parity with chat.ts).
        const childProviderFactory = createChildProviderFactory(
          telegramOpenaiBaseUrl !== undefined ? { openaiBaseUrl: telegramOpenaiBaseUrl } : {},
        );

        // Named-agent registry: session-static scan enabling `agent_type`
        // dispatch (builtin + user + project scopes, anchored at the bot cwd).
        const agentRegistry = loadAgentRegistry({
          ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
          pluginAgents: discoverPluginAgents(),
        });

        // Shared child-skill-executor factory — both SubagentExecutor and
        // SkillExecutor need it for plugin skill children to nest properly.
        // See skill-executor.ts:buildForkedChildConfig for the wiring rationale.
        const childSkillExecutorFactory = createChildSkillExecutorFactory(
          sessionConfig.model,
          telegramApiKey,
          childProviderFactory,
          telegramBaseUrl,
          undefined,
          undefined,
          sessionCwd !== undefined && sessionCwd.length > 0 ? sessionCwd : undefined,
          // Per-model credential resolver — see bootstrap.ts for rationale.
          getApiKeyForModel,
          // Surface: Telegram skill executor children inherit origin 'telegram'.
          'telegram',
          // Resolved default-subagent model threaded into nested skill
          // executors so skill→skill / skill→agent chains inherit the SAME
          // policy as the top-level executors — closing the leak where a
          // nested subagent silently defaulted to Anthropic `sonnet` under an
          // OpenAI-routed parent.
          getDefaultSubagentModel(sessionConfig.model),
          // Named-agent registry propagates to nested skill executors.
          agentRegistry,
          // OpenAI endpoint → nested restricted/depth-cap provider builders.
          telegramOpenaiBaseUrl,
        );

        // Pass `sessionConfig.model` to `getDefaultSubagentModel` for
        // parity with the chat / interactive bootstraps. The current
        // telegram wiring only reaches this branch for Anthropic parents
        // (the `isCodex` gate above), so this is defensive — but it
        // future-proofs the codex branch if/when it grows executor wiring.
        const subagentExecutor = new SubagentExecutor({
          subagentManager: rootManager,
          parentSession: deferredParent,
          // Session origin for routing-decision telemetry (Telegram → telegram).
          surface: 'telegram',
          defaultConfig: {
            apiKey: telegramApiKey,
            systemPrompt: layeredBasePrompt,
            ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
            ...(telegramOpenaiBaseUrl !== undefined ? { openaiBaseUrl: telegramOpenaiBaseUrl } : {}),
          },
          defaultSubagentModel: getDefaultSubagentModel(sessionConfig.model),
          childProviderFactory,
          childSkillExecutorFactory,
          // Per-model credential resolver — see bootstrap.ts for rationale.
          resolveApiKeyForModel: getApiKeyForModel,
          // Top-level Telegram wiring → explicit depth 0. See SubagentExecutorContext.depth.
          depth: 0,
          // Named-agent dispatch: registry + `inherit` anchor.
          agentRegistry,
          parentModel: sessionConfig.model,
          // Witness layer: thread the writer so depth ≥ 2 `agent` forks stay
          // visible in the trace. Mirrors bootstrap.ts / chat.ts.
          ...(telegramTraceWriter !== null ? { traceWriter: telegramTraceWriter } : {}),
        });

        const skillExecutor = new SkillExecutor({
          parentSession: deferredParent,
          // Session origin for skill-invocation + routing telemetry (Telegram → telegram).
          surface: 'telegram',
          defaultModel: sessionConfig.model,
          defaultSubagentModel: getDefaultSubagentModel(sessionConfig.model),
          apiKey: telegramApiKey,
          childProviderFactory,
          // Named-agent registry for skill-forked orchestrator children.
          agentRegistry,
          childSkillExecutorFactory,
          // Per-model credential resolver — mirrors bootstrap.ts / chat.ts.
          resolveApiKeyForModel: getApiKeyForModel,
          ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
          ...(telegramOpenaiBaseUrl !== undefined ? { openaiBaseUrl: telegramOpenaiBaseUrl } : {}),
          // Read-scope inheritance (#547): skill-forked children inherit the
          // parent session's read scope via the root manager. See bootstrap.ts.
          getReadScopeInputs: () => rootManager.getReadScopeInputs(),
        });

        // Compose subagents inherit the framework base + operator overlay
        // (layeredBasePrompt) but NOT ROUTING_DIRECTIVE / TOOL_SYSTEM_PROMPT /
        // end-of-turn — those are appended only by assembleSystemPrompt for the
        // parent session. Keeps DAG workers from recursing into skills / nested DAGs.
        const composeExecutor = new ComposeExecutor({
          parentSession: deferredParent,
          defaultModel: sessionConfig.model,
          defaultSubagentModel: getDefaultSubagentModel(sessionConfig.model),
          apiKey: telegramApiKey,
          // Per-model credential resolver — mirrors #640 for the compose fork-path.
          resolveApiKeyForModel: getApiKeyForModel,
          // Read-scope inheritance (#547): DAG nodes inherit the parent session's
          // read scope via the root manager. See bootstrap.ts.
          getReadScopeInputs: () => rootManager.getReadScopeInputs(),
          ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
          // Anchor DAG nodes to the worktree (re-anchored via composeExecutor.setCwd).
          ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
          systemPrompt: layeredBasePrompt ?? '',
          // Session identity for routing-decision rows (Telegram → telegram).
          surface: 'telegram',
          depth: 0,
          // Witness layer: DAG nodes emit subagent_lifecycle into the session trace.
          ...(telegramTraceWriter !== null ? { traceWriter: telegramTraceWriter } : {}),
        });

        const allowedTools = topLevelSurfaceAllowedTools(mcpManager?.getMcpToolWireNames() ?? []);
        directProvider = new AnthropicDirectProvider({
          permissions: { allowedTools },
          subagentExecutor,
          skillExecutor,
          composeExecutor,
          ...(mcpManager !== undefined ? { mcpManager } : {}),
          // Tag the presence file (~/.afk/state/presence/<id>.json) and
          // get_runtime_state as the Telegram surface. Without this the provider
          // defaults to 'cli' (anthropic-direct/index.ts) and `/watch`
          // mis-classifies Telegram sessions as CLI. The hook registry already
          // receives 'telegram' below — this aligns the provider-owned surface
          // (presence/runtime-state) with the hook-registry surface.
          surface: 'telegram',
        });

        // Bind after session creation so deferred parent proxy resolves.
        const rawPromptInner = layeredBasePrompt;
        const telegramAutoRoutingInner = config.autoRouting?.telegram ?? false;
        const systemPromptInner = typeof rawPromptInner === 'string'
          ? assembleSystemPrompt(rawPromptInner, telegramAutoRoutingInner, 'telegram')
          : rawPromptInner;

        // permissionMode is omitted from session CONSTRUCTION: AgentSession
        // defaults to 'default'. A Telegram session becomes 'autonomous' only via
        // an explicit `/afk on` (handlers/afk.ts) calling setPermissionMode —
        // never at construction. The hook bundle carries the AFK autonomous-safety
        // wiring (live mode getter → registers the afk-mode gate + tracks `/afk
        // on`; afkPromptForApproval:false → hard-refuse high-risk ops) — see
        // createTelegramAfkHookBundle + docs/afk-telegram-native-host.md.
        let telegramSessionForMode: AgentSession | undefined;
        const telegramHookBundle = createTelegramAfkHookBundle({
          memoryStore: sharedMemoryStore,
          getSession: () => telegramSessionForMode,
          cwd: sessionCwd,
          traceWriter: telegramTraceWriter,
        });
        const session = attachMcpCleanup(constructTelegramSession({
          ...(sessionConfig.apiKey !== undefined ? { apiKey: sessionConfig.apiKey } : {}),
          model: sessionConfig.model,
          // /switch resumes a prior conversation: thread the target SDK session
          // id AND the saved transcript so the AgentSession actually replays it
          // (see SessionManager.switchToSession + resumeConfigFor). Forwarding
          // only `resume` (the SDK id) resumes an EMPTY conversation — the
          // provider replays prior turns solely from resumeHistory
          // (anthropic-direct/index.ts resumeHistoryToMessages). sessionId is
          // threaded too because the provider prefers config.sessionId over
          // config.resume as the resumed id.
          ...(sessionConfig.resume !== undefined ? { resume: sessionConfig.resume } : {}),
          ...(sessionConfig.sessionId !== undefined ? { sessionId: sessionConfig.sessionId } : {}),
          ...(sessionConfig.resumeHistory !== undefined
            ? { resumeHistory: sessionConfig.resumeHistory }
            : {}),
          ...(systemPromptInner !== undefined ? { systemPrompt: systemPromptInner } : {}),
          maxTurns: 100,
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          ...(maxToolUseIterations !== undefined ? { maxToolUseIterations } : {}),
          ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
          // Pipe cwd through to tool handlers so bash/grep honor the
          // configured worktree (AFK_TELEGRAM_CWD or sessionConfig.cwd).
          ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
          provider: directProvider,
          hookRegistry: telegramHookBundle.registry,
        }, { traceWriter: telegramTraceWriter }), mcpManager);
        // Late-bind the mode source so the registry's getPermissionMode getter
        // (built above, before the session existed) reads this session's LIVE
        // permission mode — flipped by /afk on (handlers/afk.ts).
        telegramSessionForMode = session;
        returnedSession = session;
        // Wire the path-approval grant ref to the provider so elicitation
        // approvals mutate readRoots / writeRoots on the right backend.
        telegramHookBundle.pathApprovalGrantRef.current = directProvider;
        // Seed read/write roots from persisted `persist` grants so the
        // prompt's "future sessions inherit it" promise holds. No-op when none.
        seedPersistedGrants(directProvider);
        boundSession = session;
        return session;
      }

      const rawPrompt = layeredBasePrompt;
      const telegramAutoRouting = config.autoRouting?.telegram ?? false;
      const systemPrompt = typeof rawPrompt === 'string'
        ? assembleSystemPrompt(rawPrompt, telegramAutoRouting, 'telegram')
        : rawPrompt;
      // Codex branch: same cwd resolution as the Anthropic branch above.
      const codexSessionCwd = sessionCwd;
      // OpenAI-compatible endpoint for this branch's own top-level session
      // (parity with the Anthropic branch's telegramOpenaiBaseUrl above).
      const codexOpenaiBaseUrl = sessionConfig.openaiBaseUrl ?? config.openaiBaseUrl;

      // permissionMode is intentionally omitted here: AgentSession defaults
      // to 'default' (post-C2 fix), which is the correct mode for Telegram
      // sessions that rely on hook-based permission enforcement.
      // Construct the OpenAI-compatible provider explicitly (rather than letting
      // AgentSession build it internally) so we hold a handle to wire
      // path-approval. baseURL / apiKey / cwd / roots flow through the per-query
      // config (not the constructor), so omitting them here is behavior-
      // preserving vs. resolveProvider(). Without the explicit handle,
      // getGrantManager() stays undefined and BOTH path-approval and the bash
      // interpreter denylist silently fail open for OpenAI-compatible Telegram
      // sessions (PR #202 review H1). surface:'telegram' is the lone constructor
      // arg — there is no per-query surface field — and prevents the presence
      // file mis-labeling Telegram sessions as 'cli' in `/watch`.
      const codexProvider = new OpenAICompatibleProvider({
        surface: 'telegram',
        ...(mcpManager !== undefined ? { mcpManager } : {}),
      });
      // Same AFK autonomous-safety wiring as the Anthropic branch above (live
      // mode getter registers the afk-mode gate + tracks `/afk on`;
      // afkPromptForApproval:false hard-refuses high-risk ops) — see
      // createTelegramAfkHookBundle + docs/afk-telegram-native-host.md.
      let codexSessionForMode: AgentSession | undefined;
      const codexHookBundle = createTelegramAfkHookBundle({
        memoryStore: sharedMemoryStore,
        getSession: () => codexSessionForMode,
        cwd: codexSessionCwd,
        traceWriter: telegramTraceWriter,
      });
      const session = attachMcpCleanup(constructTelegramSession({
        ...(sessionConfig.apiKey !== undefined ? { apiKey: sessionConfig.apiKey } : {}),
        model: sessionConfig.model,
        // /switch resume: continue the target SDK session AND replay its saved
        // transcript (parity with the Anthropic branch). The openai-compatible
        // provider seeds prior turns from resumeHistory (messages.ts / query.ts),
        // so omitting it resumes an empty conversation.
        ...(sessionConfig.resume !== undefined ? { resume: sessionConfig.resume } : {}),
        ...(sessionConfig.sessionId !== undefined ? { sessionId: sessionConfig.sessionId } : {}),
        ...(sessionConfig.resumeHistory !== undefined
          ? { resumeHistory: sessionConfig.resumeHistory }
          : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        maxTurns: 100,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(maxToolUseIterations !== undefined ? { maxToolUseIterations } : {}),
        // Sets config.openaiBaseUrl -> effectiveBaseURL (openai-compatible/index.ts)
        // so this top-level OpenAI Telegram session reaches the configured shim
        // instead of defaulting to api.openai.com.
        ...(codexOpenaiBaseUrl !== undefined ? { openaiBaseUrl: codexOpenaiBaseUrl } : {}),
        ...(codexSessionCwd !== undefined && codexSessionCwd.length > 0
          ? { cwd: codexSessionCwd }
          : {}),
        provider: codexProvider,
        hookRegistry: codexHookBundle.registry,
      }, { traceWriter: telegramTraceWriter }), mcpManager);
      // Late-bind the mode source (see Anthropic branch) so the gate's getter
      // reads this session's live permission mode.
      codexSessionForMode = session;
      returnedSession = session;
      // Wire the path-approval grant ref + seed persisted `persist` grants so
      // the OpenAI Telegram surface gets the same restricted-path prompts and
      // persisted-grant replay as the Anthropic branch.
      codexHookBundle.pathApprovalGrantRef.current = codexProvider;
      seedPersistedGrants(codexProvider);

        return session;
      } catch (error) {
        if (returnedSession !== undefined) {
          await returnedSession.close().catch(() => undefined);
        } else if (mcpManager !== undefined) {
          await mcpManager.disconnectAll();
        }
        throw error;
      }
    },
  });

  // Elicitation wiring (path-approval + ask_question) is installed inside
  // `bot.start()` via composeTelegramElicitation — a SINGLE composed handler,
  // so the two systems no longer clobber each other on `elicitationRouter
  // .install` (PR #477 review B1/B2). See `TelegramBot.start()`.
  try {
    bot.start();
    console.log('✅ Bot started successfully!');
    console.log('\n📝 Slash commands (Agent SDK):');
    console.log('  /start   - Welcome and command list');
    console.log('  /help    - Show command list');
    console.log('  /clear   - Clear conversation history');
    console.log('  /compact - Compact history (summarize older messages)');
    console.log('  /model   - Switch model (opus/sonnet/haiku/gpt-5.4/...)');
    console.log('\n💬 Send any message to chat with the agent.');
    console.log('\n⏹️  Press Ctrl+C to stop the bot.');

    // Consecutive version-drift deferrals across stats ticks. Held here (not in
    // the watchdog function, which is pure) so it survives between ticks; reset
    // to 0 by decideVersionDriftAction() whenever drift clears or we exit.
    let driftDeferrals = 0;

    const statsInterval = setInterval(() => {
      const stats = bot.getStats();
      console.log(`\n📊 Stats: ${stats.activeSessions} active sessions, ${stats.totalChats} total chats`);

      // Version drift check — re-reads package.json and compares to startup version.
      // Exits cleanly so the updated binary takes over on next restart/supervision.
      try {
        const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
        const diskVersion = pkg.version ?? 'unknown';
        const result = checkVersionDrift(DAEMON_VERSION, diskVersion);

        // Invariant: never exit mid-turn — but never defer forever either.
        // The drift-exit hands the chat off to a freshly-installed binary via
        // launchd KeepAlive; exiting while a session is streaming severs the
        // in-flight turn (plus its queued messages and sub-agent dispatch), and
        // the cold relaunch cannot resume it ("An unexpected error occurred").
        // So defer while any session is mid-turn (PR #106). The bounded escape
        // hatch: a session wedged in processing/streaming would otherwise defer
        // the upgrade forever (stuck-busy livelock), so after MAX_DRIFT_DEFERRALS
        // deferrals (~1h at this 5-min tick) force the exit anyway.
        const busy = result.drift ? bot.getBusySessionCount() : 0;
        const decision = decideVersionDriftAction({
          drift: result,
          busyCount: busy,
          deferrals: driftDeferrals,
        });
        driftDeferrals = decision.deferrals;
        switch (decision.action) {
          case 'none':
            break;
          case 'defer':
            if (decision.message !== undefined) console.log(`⚠️ ${decision.message}`);
            break;
          case 'exit':
          case 'force-exit':
            if (decision.message !== undefined) console.log(`⚠️ ${decision.message}`);
            process.exit(0);
        }
      } catch {
        console.warn('⚠️ [daemon] Could not re-read package.json for version drift check — skipping.');
      }
    }, 300000);

    const shutdown = async () => {
      console.log('\n\n🛑 Shutting down bot...');
      clearInterval(statsInterval);
      await bot.stop();
      sharedMemoryStore.close();
      console.log('✅ Bot stopped.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

/** Telegram-specific config keys that file values override shell env for. */
const TELEGRAM_FILE_AUTHORITATIVE_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
  'TELEGRAM_VERBOSE',
  'TELEGRAM_DATA_DIR',
];

/**
 * Parse a dotenv-format file into a key→value map. Skips comments and
 * blank lines; strips matching surrounding quotes. Returns an empty map
 * when the file is missing or unreadable.
 *
 * Exported for tests. Behavior matches the subset of dotenv's parser
 * we depend on; we don't use dotenv directly because we need to read
 * the file without applying it to process.env.
 */
function parseEnvFile(filePath: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(filePath)) return out;
  try {
    const contents = readFileSync(filePath, 'utf-8');
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out.set(key, value);
    }
  } catch {
    /* unreadable — treat as missing */
  }
  return out;
}

/**
 * For each Telegram-authoritative key, copy the file value into
 * process.env even when an existing shell-set value disagrees. When an
 * override happens, log a one-line notice so the operator sees what
 * changed. No-op for keys not present in the file (shell value remains).
 *
 * This inverts dotenv's standard precedence for Telegram config only —
 * see the callsite in main() for the design rationale.
 */
function applyTelegramFileOverrides(filePath: string): void {
  const fileVars = parseEnvFile(filePath);
  for (const key of TELEGRAM_FILE_AUTHORITATIVE_KEYS) {
    const fileVal = fileVars.get(key);
    if (fileVal === undefined) continue;
    const envVal = process.env[key]; // audit-env-access: allow — dynamic loop over fixed allowlist
    if (envVal !== undefined && envVal !== fileVal) {
      // Mask the token in the log — bot tokens look like
      // `12345:AbCdEf...` so we keep the bot-id prefix for diagnosability
      // but redact the secret half.
      const masked = (raw: string): string => {
        if (key !== 'TELEGRAM_BOT_TOKEN') return raw;
        const colon = raw.indexOf(':');
        if (colon === -1) return `${raw.slice(0, 4)}***`;
        return `${raw.slice(0, colon + 1)}***`;
      };
      console.log(
        `🔧 ${key}: file value (${masked(fileVal)}) overrides shell value (${masked(envVal)})`,
      );
    }
    process.env[key] = fileVal;
  }
}

main().catch(error => {
  console.error('❌ Unhandled error:', error);
  process.exit(1);
});
