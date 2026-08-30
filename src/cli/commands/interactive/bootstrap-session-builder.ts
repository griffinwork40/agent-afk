import { AgentSession } from '../../../agent/session.js';
import type { PermissionMode } from '../../../agent/types/sdk-types.js';
import { injectHotMemory } from '../../../agent/memory/index.js';
import { injectCompanionPrimer } from '../../../agent/companion/index.js';
import type { ThinkingConfig, EffortLevel } from '../../../agent/types.js';
import type { AgentConfig } from '../../../agent/types.js';
import type { ModelProvider } from '../../../agent/provider.js';
import type { HookRegistry } from '../../../agent/hooks.js';
import type { TraceWriter } from '../../../agent/trace/index.js';
import { explicitProviderHints, getApiKeyForModel } from '../../shared-helpers.js';
import type { CliConfig } from '../../config.js';

/**
 * Dependencies for constructing a fresh `AgentSession`. Captures everything
 * the constructor block reads so `buildAgentSession` can be called both from
 * `bootstrapSession` (initial) and from the mid-session swap path.
 */
export interface BuildAgentSessionDeps {
  model: string;
  resumeConfig: Partial<AgentConfig>;
  systemPrompt: string | undefined;
  systemPromptSource: string | undefined;
  thinking: ThinkingConfig | undefined;
  effort: EffortLevel | undefined;
  maxOutputTokens: number | undefined;
  /**
   * Opt-in top-level tool-use-round ceiling (from AFK_MAX_TOOL_USE_ITERATIONS).
   * `undefined` = unlimited (no behavior change). Flows to
   * `AgentConfig.maxToolUseIterations` and hits both providers via
   * `resolveMaxToolIterations()`. Top-level only — subagent forks set their own.
   */
  maxToolUseIterations: number | undefined;
  /**
   * Fully-wired provider factory. Passed as `config.providerFactory` so the
   * ProviderRouter builds a wired provider (with executors, memoryStore,
   * mcpManager) on every turn — enabling cross-family /model swaps without
   * losing the agent/skill/compose tools or MCP bridges.
   */
  providerFactory: (model: string | undefined) => ModelProvider;
  hookRegistry: HookRegistry;
  traceWriter: TraceWriter | undefined;
  drainSubagents?: ((reason: string) => Promise<unknown>) | undefined;
  cwd: string | undefined;
  maxTurns: number;
  autoResumeOnUsageLimit: boolean | undefined;
  /** Initial session permission mode (e.g. 'bypassPermissions'). Omit for 'default'. */
  permissionMode?: PermissionMode;
  baseUrl?: string;
  /** Sampling temperature when explicitly set by the user. */
  temperature?: number;
  /**
   * CLI `--provider` value when set. Threaded into credential resolution so
   * `afk i --provider xai` does not inject Anthropic material for a Claude
   * default model.
   */
  explicitProvider?: string;
}

/**
 * Construct a fresh `AgentSession` from the supplied deps. Extracted so the
 * mid-session swap path can build a new session with a different `resumeConfig`
 * without duplicating the constructor argument list.
 */
export function buildAgentSession(deps: BuildAgentSessionDeps): AgentSession {
  return new AgentSession(injectCompanionPrimer(injectHotMemory({
    model: deps.model,
    // User-facing surface for trace `origin` attribution. The REPL is a CLI
    // entrypoint → 'cli'. (Mid-session swap reuses this helper, also 'cli'.)
    surface: 'cli',
    // Resolve the credential for the ACTUAL session model + explicit
    // `--provider` (if any), not the env-derived default alone. Without
    // explicit hints, `afk i --provider xai` with a Claude model would inject
    // Anthropic material into XaiProvider forced-apikey mode.
    apiKey: getApiKeyForModel(deps.model, explicitProviderHints(deps.explicitProvider)),
    maxTurns: deps.maxTurns,
    hookRegistry: deps.hookRegistry,
    ...(deps.permissionMode !== undefined ? { permissionMode: deps.permissionMode } : {}),
    ...(deps.systemPrompt !== undefined ? { systemPrompt: deps.systemPrompt } : {}),
    ...(deps.systemPromptSource !== undefined ? { systemPromptSource: deps.systemPromptSource } : {}),
    ...(deps.thinking !== undefined ? { thinking: deps.thinking } : {}),
    ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
    ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
    ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
    ...(deps.maxToolUseIterations !== undefined ? { maxToolUseIterations: deps.maxToolUseIterations } : {}),
    ...deps.resumeConfig,
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
    ...(deps.traceWriter !== undefined ? { traceWriter: deps.traceWriter } : {}),
    ...(deps.drainSubagents !== undefined ? { drainSubagents: deps.drainSubagents } : {}),
    ...(deps.autoResumeOnUsageLimit !== undefined
      ? { autoResumeOnUsageLimit: deps.autoResumeOnUsageLimit }
      : {}),
    ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
    providerFactory: deps.providerFactory,
  })), deps.traceWriter);
}

/**
 * Assemble the {@link BuildAgentSessionDeps} bundle shared by the initial
 * session build and the mid-session `/resume` swap closure. Extracted from
 * `bootstrapSession` so the argument list constructed once there is testable
 * in isolation from the heavy session/executor/provider wiring above it.
 */
export function buildSharedDeps(a: {
  sessionModel: string;
  resumeConfig: Partial<AgentConfig>;
  systemPrompt: string | undefined;
  systemPromptSource: string | undefined;
  thinking: ThinkingConfig | undefined;
  effort: EffortLevel | undefined;
  maxOutputTokens: number | undefined;
  maxToolUseIterations: number | undefined;
  cliConfig: CliConfig;
  providerFactory: (m: string | undefined) => ModelProvider;
  hookRegistry: HookRegistry;
  traceWriter: TraceWriter | undefined;
  drainSubagents?: ((reason: string) => Promise<unknown>) | undefined;
  effectiveCwd: string | undefined;
  maxTurns: string;
  initialPermissionMode: PermissionMode | undefined;
  explicitProvider?: string;
}): BuildAgentSessionDeps {
  return {
    model: a.sessionModel,
    resumeConfig: a.resumeConfig,
    systemPrompt: a.systemPrompt,
    systemPromptSource: a.systemPromptSource,
    thinking: a.thinking,
    effort: a.effort,
    maxOutputTokens: a.maxOutputTokens,
    maxToolUseIterations: a.maxToolUseIterations,
    ...(a.cliConfig.baseUrl !== undefined ? { baseUrl: a.cliConfig.baseUrl } : {}),
    ...(a.cliConfig.temperature !== 1.0 ? { temperature: a.cliConfig.temperature } : {}),
    providerFactory: a.providerFactory,
    hookRegistry: a.hookRegistry,
    traceWriter: a.traceWriter,
    drainSubagents: a.drainSubagents,
    cwd: a.effectiveCwd,
    maxTurns: parseInt(a.maxTurns, 10),
    autoResumeOnUsageLimit: a.cliConfig.autoResumeOnUsageLimit,
    ...(a.initialPermissionMode !== undefined ? { permissionMode: a.initialPermissionMode } : {}),
    ...(a.explicitProvider !== undefined ? { explicitProvider: a.explicitProvider } : {}),
  };
}
