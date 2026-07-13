import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { providerForModel, AnthropicDirectProvider } from '../agent/providers/index.js';
import { OpenAICompatibleProvider } from '../agent/providers/openai-compatible/index.js';
import type { ModelProvider } from '../agent/provider.js';
import { BUILTIN_TOOL_NAMES } from '../agent/tools/schemas.js';
import { MEMORY_TOOL_NAMES } from '../agent/memory/index.js';
import { AWARENESS_TOOL_NAMES } from '../agent/awareness/index.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from '../agent/tools/handlers/exit-plan-mode.js';

import type { AgentModelInput, ThinkingConfig, EffortLevel } from '../agent/types.js';
import { loadConfig } from './config.js';
import { loadOpenAICredential, resolveCredentialForModel } from '../agent/auth/credential-resolver.js';
import { env } from '../config/env.js';
import type { GrantManager } from './slash/commands/allow-dir.js';

/**
 * Load the runtime system prompt from the installed package
 * (`<root>/prompts/system-prompt.md`), not from the user's cwd. Resolves
 * correctly from both the compiled `dist/cli/` and the source `src/cli/`
 * locations.
 *
 * Works for any provider — the Codex adapter writes the resolved text to a
 * temp `model_instructions_file` when the Anthropic preset conventions
 * don't map cleanly.
 */
export function loadSystemPrompt(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = resolve(here, '..', '..', 'prompts', 'system-prompt.md');
  if (!existsSync(promptPath)) return undefined;
  try {
    return readFileSync(promptPath, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Load systemPrompt from env or afk.config.json, if set.
 * Precedence: AFK_SYSTEM_PROMPT env > cwd/afk.config.json >
 *   ~/.afk/config/afk.config.json > legacy ~/.afk.config.json >
 *   cwd/AFK.md > $AFK_HOME/AFK.md.
 * Mirrors the telegram entrypoint so CLI and bot read the same config surface.
 *
 * Delegates to `loadConfig()` to share the same 3-tier walk and disk-cache.
 * Previously this function did its own duplicate walk — a measurable
 * cold-start tax since `afk chat` calls both `loadConfigSystemPrompt()`
 * (here) and `loadConfig()` (for provenance) on the same critical path.
 * The two are documented as identical in production (see chat.ts:132-137);
 * routing both through `loadConfig()` makes them share work.
 */
export function loadConfigSystemPrompt(): string | undefined {
  return loadConfig().systemPrompt;
}

/**
 * Header inserted between the framework base prompt and the operator overlay.
 *
 * Invariant: only emitted when BOTH a framework base and an overlay are
 * present (see {@link composeSystemPrompt}). The "above" reference therefore
 * never dangles — it always points at the framework operating posture.
 */
export const OPERATOR_CONFIG_HEADER =
  "# Operator configuration\n\n" +
  "The instructions below come from this operator's configuration (AFK.md, " +
  'afk.config.json, or AFK_SYSTEM_PROMPT). Treat them as refinements layered ' +
  'on top of the operating posture above — follow them unless they conflict ' +
  'with the Priorities or Constraints already stated.';

/**
 * Compose the final base system prompt from the unconditional framework base
 * and the optional operator overlay.
 *
 * Contract: the framework base (`prompts/system-prompt.md`) is the foundation
 * whenever present; the overlay is APPENDED beneath {@link OPERATOR_CONFIG_HEADER},
 * never substituted for the base. Empty / whitespace-only inputs are treated
 * as absent so a blank AFK.md or a missing prompt file never injects a
 * dangling header or a leading newline.
 *   - both present  → `${framework}\n\n${header}\n\n${overlay}`
 *   - framework only → framework
 *   - overlay only   → overlay (framework genuinely absent — dev/test edge)
 *   - neither        → undefined
 */
export function composeSystemPrompt(
  framework: string | undefined,
  overlay: string | undefined,
): string | undefined {
  const fw = framework !== undefined && framework.trim().length > 0 ? framework : undefined;
  const ov = overlay !== undefined && overlay.trim().length > 0 ? overlay : undefined;
  if (fw === undefined) return ov;
  if (ov === undefined) return fw;
  return `${fw}\n\n${OPERATOR_CONFIG_HEADER}\n\n${ov}`;
}

/**
 * Resolve the surface base system prompt: the unconditional framework base
 * (`prompts/system-prompt.md`, inlined at publish-build) with the resolved
 * operator overlay (`AFK_SYSTEM_PROMPT` → `afk.config.json` → `AFK.md`)
 * appended on top. Used by every top-level surface (one-shot `chat`, REPL,
 * Telegram, farm) so they share one layering rule.
 *
 * Returns the composed `prompt` plus a layered `source` string for
 * `--dump-prompt` provenance: `framework+<overlaySource>` when both are
 * present, `framework` when only the base is, `<overlaySource>` when only the
 * overlay is (framework absent), or `none`. The plain overlay source remains
 * available unchanged via `loadConfig().systemPromptSource`.
 */
export function resolveBaseSystemPrompt(): { prompt: string | undefined; source: string } {
  const framework = loadSystemPrompt();
  const cfg = loadConfig();
  const overlay = cfg.systemPrompt;
  const overlaySource = cfg.systemPromptSource;
  const hasFw = framework !== undefined && framework.trim().length > 0;
  const hasOv = overlay !== undefined && overlay.trim().length > 0;
  let source: string;
  if (hasFw && hasOv) source = `framework+${overlaySource ?? 'unknown'}`;
  else if (hasFw) source = 'framework';
  else if (hasOv) source = overlaySource ?? 'unknown';
  else source = 'none';
  return { prompt: composeSystemPrompt(framework, overlay), source };
}

/**
 * Get a provider-appropriate API key from the environment for the current
 * session's model.
 *
 * History: this used to return `loadCredential()` unconditionally — the
 * Anthropic chain (env → Claude Code keychain). That leaked an `sk-ant-oat01-…`
 * OAuth token into the `apiKey` field of every `AgentSession` regardless of
 * which provider the model resolved to. The openai-compatible provider then
 * sent the Claude OAuth token as a Bearer header to OpenAI-shaped endpoints
 * (OpenCode Zen, OpenRouter, Together, etc.), which 401'd, and the generic
 * auth-error mapper stamped "Verify ANTHROPIC_API_KEY" on the failure — a
 * misleading diagnostic that hid the underlying credential cross-wiring.
 *
 * The resolver now delegates to `getApiKeyForModel` which reads
 * `AFK_MODEL` / `CLAUDE_MODEL` from env, routes via `providerForModel` (which
 * also honors `AFK_PROVIDER` and the `AFK_OPENAI_BASE_URL` env-hint tier),
 * and returns the OpenAI-shaped credential chain for non-Anthropic providers.
 * Callers that explicitly want the Anthropic credential surface (e.g., the
 * `doctor` and `status` diagnostic surfaces) should call `loadCredential()`
 * directly instead.
 *
 * Resolves against `getModel()` — not a raw re-read of `AFK_MODEL` /
 * `CLAUDE_MODEL` — so the credential always matches the same model string the
 * session actually runs with, including the `'sonnet'` default when both env
 * vars are unset. Re-reading the raw env pair here previously let this
 * resolve `undefined` (routing via the `AFK_OPENAI_BASE_URL` Tier-4 hint to
 * `openai-compatible`) while `getModel()` returned the `'sonnet'` default
 * (`anthropic-direct`) — an undefined-vs-defaulted divergence that paired an
 * anthropic-routed model with an OpenAI credential and 401'd.
 */
export function getApiKey(): string | undefined {
  return getApiKeyForModel(getModel());
}

/**
 * Get a Codex-compatible API key from the environment, if present.
 *
 * Delegates to `loadOpenAICredential` in `src/agent/auth/credential-resolver.ts`
 * — the canonical implementation now lives there so the agent layer can call
 * it directly without an upward import into `src/cli/`.
 */
export function getCodexApiKey(): string | undefined {
  return loadOpenAICredential();
}

/**
 * Resolve a provider-appropriate API key for a given model. Anthropic models
 * read `ANTHROPIC_API_KEY` (via `loadCredential` — env + Claude Code keychain);
 * Codex-routed and openai-compatible models read `OPENAI_API_KEY` /
 * `CODEX_API_KEY` env only (never the Anthropic keychain).
 *
 * Delegates to `resolveCredentialForModel` in `src/agent/auth/credential-resolver.ts`
 * — the canonical implementation now lives there so the agent layer can call
 * it directly without an upward import into `src/cli/`.
 */
export function getApiKeyForModel(model: string | undefined): string | undefined {
  return resolveCredentialForModel(model);
}

/**
 * Get the configured model string from the environment.
 *
 * Precedence: `AFK_MODEL` (canonical) → `CLAUDE_MODEL` (legacy alias) →
 * `'medium'` (default). Defaulting to the `medium` capability TIER (not the
 * fixed `'sonnet'` identity alias) is deliberate: a user who rebinds
 * `AFK_MODEL_MEDIUM` / `models.medium` changes the default session model, while
 * an unconfigured install still resolves `medium` → Claude Sonnet. The return
 * value is a bare `AgentModelInput` — tier aliases, Claude identity handles, and
 * any provider-native id all pass through untouched to the downstream resolver.
 */
export function getModel(): AgentModelInput {
  const raw = env.AFK_MODEL ?? env.CLAUDE_MODEL;
  if (!raw || raw.length === 0) return 'medium';
  return raw;
}

/**
 * Get the default model for dispatched subagents (`agent` and `skill` tools).
 *
 * Precedence:
 *   1. `AFK_DEFAULT_SUBAGENT_MODEL` env (when set, always wins).
 *   2. If the parent session routes to `openai-compatible` (any non-Claude
 *      provider — GPT/o-series, codex-*, HF-style local ids) → return the
 *      parent model. Without this, a local-only setup silently dispatches
 *      subagents to api.anthropic.com because the literal `'medium'` fallback
 *      below routes back through `providerForModel` → `anthropic-direct`.
 *   3. `'medium'` (the medium capability tier). Preserved for Claude parents so
 *      the historical cost-management intent — "high-tier parent (e.g. opus)
 *      shouldn't auto-spawn high-tier children" — keeps working; and because it
 *      is the rebindable TIER (not the fixed `'sonnet'` identity alias), a user
 *      who rebinds `medium` redirects default subagents along with it.
 *
 * The `parentModel` arg is what enables (2); callers that don't pass it
 * (legacy / test) get the original env-var-or-`'medium'` behavior.
 *
 * Pass-through like `getModel()` — short aliases and provider-native ids both
 * work.
 */
export function getDefaultSubagentModel(parentModel?: AgentModelInput): AgentModelInput {
  const raw = env.AFK_DEFAULT_SUBAGENT_MODEL;
  if (raw && raw.length > 0) return raw;
  if (typeof parentModel === 'string' && providerForModel(parentModel) === 'openai-compatible') {
    return parentModel;
  }
  return 'medium';
}

/**
 * Parse thinking mode from string input.
 * Expected formats: 'adaptive', 'disabled', 'enabled:<budget>', 'enabled:max'.
 *
 * The `'max'` sentinel leaves budgetTokens as `Number.POSITIVE_INFINITY`; it's
 * resolved to the model-specific ceiling later in `buildQueryOptions`, where
 * the resolved model ID is known.
 */
export function parseThinking(raw: string | undefined): ThinkingConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'adaptive') return { type: 'adaptive' };
  if (raw === 'disabled') return { type: 'disabled' };
  if (raw === 'enabled:max') {
    return { type: 'enabled', budgetTokens: Number.POSITIVE_INFINITY };
  }
  const m = /^enabled:(\d+)$/.exec(raw);
  if (m) {
    const budgetTokens = parseInt(m[1]!, 10);
    if (Number.isNaN(budgetTokens)) throw new Error(`Invalid thinking budget: ${raw}`);
    return { type: 'enabled', budgetTokens };
  }
  throw new Error(`Invalid --thinking value: ${raw}. Expected 'adaptive' | 'disabled' | 'enabled:<N>' | 'enabled:max'`);
}

/**
 * Valid effort levels
 */
const VALID_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Parse effort level from string input.
 */
export function parseEffort(raw: string | undefined): EffortLevel | undefined {
  if (raw === undefined) return undefined;
  if ((VALID_EFFORT_LEVELS as readonly string[]).includes(raw)) return raw as EffortLevel;
  throw new Error(`Invalid --effort value: ${raw}. Expected one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
}

/**
 * Get thinking mode from environment
 */
export function getThinking(): ThinkingConfig | undefined {
  return parseThinking(env.AFK_THINKING);
}

/**
 * Get effort level from environment
 */
export function getEffort(): EffortLevel | undefined {
  return parseEffort(env.AFK_EFFORT);
}

/**
 * Parse a USD budget value from a CLI flag or env var. Accepts positive or
 * zero numbers (zero is a meaningful hard-stop sentinel — every dollar is
 * over budget). Rejects negatives, non-numeric strings, and NaN.
 *
 * The returned number is fed to the SDK as `options.maxBudgetUsd` /
 * `options.taskBudget` — see `buildQueryOptions`.
 */
export function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === '' || raw === 'NaN') {
    throw new Error(`Invalid --max-budget-usd value: ${JSON.stringify(raw)}. Expected a non-negative number.`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --max-budget-usd value: ${JSON.stringify(raw)}. Expected a non-negative number.`);
  }
  if (parsed < 0) {
    throw new Error(`Invalid --max-budget-usd value: ${JSON.stringify(raw)}. Must be non-negative.`);
  }
  return parsed;
}

/**
 * Read session-wide budget ceiling from environment.
 * Surfaces any parse error the caller can translate into a friendly message.
 */
export function getMaxBudgetUsd(): number | undefined {
  return parseBudget(env.AFK_MAX_BUDGET_USD);
}

/**
 * Read per-task budget hint from environment.
 */
export function getTaskBudget(): number | undefined {
  return parseBudget(env.AFK_TASK_BUDGET);
}

/**
 * Parse `--max-output-tokens` / `AFK_MAX_OUTPUT_TOKENS`. Accepts a positive
 * integer or the `'max'` sentinel (which resolves to the model's ceiling in
 * `buildQueryOptions`, encoded here as `Number.POSITIVE_INFINITY`). Rejects
 * zero, negatives, NaN, and non-integer strings.
 *
 * The resolved number flows to `AgentConfig.maxOutputTokens`, where
 * `resolveMaxTokens` (anthropic-direct provider) clamps it to the model's
 * output ceiling before it becomes the Messages-API `max_tokens`.
 */
export function parseMaxOutputTokens(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'max') return Number.POSITIVE_INFINITY;
  if (raw === '' || raw === 'NaN') {
    throw new Error(`Invalid --max-output-tokens value: ${JSON.stringify(raw)}. Expected a positive integer or 'max'.`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --max-output-tokens value: ${JSON.stringify(raw)}. Expected a positive integer or 'max'.`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --max-output-tokens value: ${JSON.stringify(raw)}. Must be a positive integer.`);
  }
  return parsed;
}

/**
 * Read max-output-tokens ceiling from environment.
 */
export function getMaxOutputTokens(): number | undefined {
  return parseMaxOutputTokens(env.AFK_MAX_OUTPUT_TOKENS);
}

/**
 * Parse `AFK_MAX_TOOL_USE_ITERATIONS` — the opt-in top-level tool-use-round
 * ceiling. Lenient by design (this is an operator escape-hatch, not a CLI flag):
 * `undefined`, empty, non-numeric, or a value `<= 0` all resolve to `undefined`,
 * meaning "no top-level cap" — identical to leaving `AgentConfig.maxToolUseIterations`
 * unset (see `resolveMaxToolIterations` in `providers/shared/tool-loop-cap.ts`,
 * where both `undefined` and `0` mean unlimited). A positive value is floored to
 * an integer. Returning `undefined` (not `0`) on the unset path keeps the field
 * ABSENT from the config so there is zero behavior change when the var is unset.
 */
export function parseMaxToolUseIterations(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/**
 * Read the opt-in top-level tool-use-round ceiling from environment. Feeds the
 * top-level `AgentConfig.maxToolUseIterations` default at every top-level session
 * surface (chat, interactive, telegram, daemon, scheduler) via
 * `explicit ?? getMaxToolUseIterations()`, so an explicit config value always
 * wins. Returns `undefined` when unset/`<=0` (unlimited — no behavior change).
 * Subagent forks are unaffected: they set their own non-zero default in
 * `subagent.ts` / `child-config.ts` and never read this.
 */
export function getMaxToolUseIterations(): number | undefined {
  return parseMaxToolUseIterations(env.AFK_MAX_TOOL_USE_ITERATIONS);
}

const VALID_PROVIDERS: readonly string[] = [
  'anthropic',
  'anthropic-direct',
  'openai-codex',
  'openai',
  'openai-compatible',
];

/**
 * Parse a provider string into a ModelProvider instance.
 * Optionally accepts executors to enable the Agent and Skill tools.
 *
 * When `raw` is undefined AND `opts.model` is supplied, the function consults
 * `providerForModel(model)` to auto-select between `anthropic-direct` and
 * `openai-compatible`. This is what lets `AFK_OPENAI_BASE_URL=… AFK_MODEL=mlx-community/…`
 * route to the local OpenAI-shim server without an explicit `--provider` flag.
 * Without a model hint, returns `undefined` so the CLI falls back to its
 * hardcoded AnthropicDirectProvider (legacy default; preserved for callers
 * that pass `parseProvider(undefined)` with no model context).
 *
 * Returns `undefined` for `'openai-codex'` so the session falls through to
 * the model-router in `providers/index.ts:resolveProvider` — which, after
 * slice 5 of the 2026-05-18 provider refactor, routes GPT/o-series models
 * to `OpenAICompatibleProvider`. Keeping the value in `VALID_PROVIDERS` is
 * pure backward-compat (existing scripts that pass `--provider openai-codex`
 * keep working).
 */
export function parseProvider(
  raw: string | undefined,
  opts?: {
    subagentExecutor?: import('../agent/tools/subagent-executor.js').SubagentExecutor;
    skillExecutor?: import('../agent/tools/skill-executor.js').SkillExecutor;
    composeExecutor?: import('../agent/tools/compose-executor.js').ComposeExecutor;
    /** Shared MemoryStore to pass into providers so only one SQLite DB is opened. */
    memoryStore?: import('../agent/memory/index.js').MemoryStore;
    /**
     * Optional MCP manager. When supplied, every tool exposed by a
     * `connected` MCP server is added to the provider's allow-list AND
     * the provider's tool schema set (via the provider's own constructor).
     */
    mcpManager?: import('../agent/mcp/index.js').McpManager;
    /**
     * Model string used to auto-select a provider when `raw` is undefined.
     * Wired through providerForModel() — accepts Claude short aliases, full
     * `claude-*` ids, GPT/o-series, codex-*, and HF-style `org/model` ids.
     */
    model?: string;
    /**
     * Base URL for OpenAI-compatible endpoint (e.g. local mlx_lm.server,
     * Ollama OpenAI-compat). Forwarded to OpenAICompatibleProvider as
     * `baseURL`. Ignored when the selected provider is anthropic-direct.
     */
    openaiBaseUrl?: string;
  },
): ModelProvider | undefined {
  // Auto-route: when --provider is omitted but a model hint is available,
  // consult the model-router so HF-style local model ids (mlx-community/…,
  // TheBloke/…) and GPT/o-series default to openai-compatible without the
  // operator having to type `--provider openai-compatible` every launch.
  //
  // We thread `openaiBaseUrl` into the router so its Tier 4 env-hint fires
  // off `cliConfig.openaiBaseUrl` (already normalized) rather than re-reading
  // raw env — guarantees parity with the rest of the bootstrap flow when
  // a test or caller has overridden the URL.
  let effective = raw;
  if (effective === undefined && opts?.model !== undefined) {
    const routed = providerForModel(opts.model, {
      ...(opts.openaiBaseUrl !== undefined ? { openaiBaseUrl: opts.openaiBaseUrl } : {}),
    });
    // Only override for non-Anthropic routes — Anthropic is the legacy
    // default the caller's fallback already constructs, so leaving
    // `effective` undefined preserves the existing executor wiring path.
    if (routed === 'openai-compatible') effective = 'openai-compatible';
  }
  if (effective === undefined) return undefined;
  if (!VALID_PROVIDERS.includes(effective)) {
    throw new Error(`Invalid --provider value: ${effective}. Expected one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  const allowedToolsFor = (): string[] => {
    // Awareness tools (`get_runtime_state`) are registered unconditionally by
    // every provider (see `anthropic-direct/index.ts`, `openai-compatible/index.ts`),
    // so the allowlist must include them or the dispatcher's permission gate
    // rejects the registered handler. Source of truth: `agent/awareness/tool.ts`.
    // `exit_plan_mode` is registered only while in plan mode, but the allowlist
    // is static (snapshotted at construction), so its name must be present here
    // or the gate rejects it the moment the model calls it. Harmless when the
    // tool is not registered (the dispatcher just never routes to it).
    const list = [...BUILTIN_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...AWARENESS_TOOL_NAMES, EXIT_PLAN_MODE_TOOL_NAME];
    if (opts?.subagentExecutor) list.push('agent');
    if (opts?.skillExecutor) list.push('skill');
    if (opts?.composeExecutor) list.push('compose');
    // Bridge: every MCP-bridged tool must appear on the permission allow-list
    // or the dispatcher's `enforcePermissions()` will reject it as an
    // unknown tool. Wire names are stable for the manager's lifetime.
    if (opts?.mcpManager) list.push(...opts.mcpManager.getMcpToolWireNames());
    return list;
  };
  if (effective === 'anthropic' || effective === 'anthropic-direct') {
    return new AnthropicDirectProvider({
      permissions: { allowedTools: allowedToolsFor() },
      subagentExecutor: opts?.subagentExecutor,
      skillExecutor: opts?.skillExecutor,
      composeExecutor: opts?.composeExecutor,
      ...(opts?.memoryStore !== undefined ? { memoryStore: opts.memoryStore } : {}),
      ...(opts?.mcpManager !== undefined ? { mcpManager: opts.mcpManager } : {}),
    });
  }
  if (effective === 'openai' || effective === 'openai-compatible') {
    // Same allowed-tools shape as anthropic-direct so the model gets the
    // same builtin surface (bash/read_file/edit_file/etc.) plus optional
    // agent/skill/compose when executors are injected.
    return new OpenAICompatibleProvider({
      permissions: { allowedTools: allowedToolsFor() },
      ...(opts?.subagentExecutor !== undefined ? { subagentExecutor: opts.subagentExecutor } : {}),
      ...(opts?.skillExecutor !== undefined ? { skillExecutor: opts.skillExecutor } : {}),
      ...(opts?.composeExecutor !== undefined ? { composeExecutor: opts.composeExecutor } : {}),
      ...(opts?.memoryStore !== undefined ? { memoryStore: opts.memoryStore } : {}),
      ...(opts?.mcpManager !== undefined ? { mcpManager: opts.mcpManager } : {}),
      ...(opts?.openaiBaseUrl !== undefined ? { baseURL: opts.openaiBaseUrl } : {}),
    });
  }
  return undefined;
}

/**
 * Structural type guard for the {@link GrantManager} interface.
 *
 * Invariant: the guard checks function presence only — it does NOT validate
 * return-type shapes or implementation correctness. Any provider that exposes
 * the four GrantManager methods (addReadRoot, addWriteRoot, revokeRoot,
 * getGrants) will pass, regardless of its concrete class. This intentionally
 * avoids `instanceof` so future providers are wired automatically without
 * touching the bootstrap gate.
 */
export function isGrantManager(p: unknown): p is GrantManager {
  if (p === null || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  return (
    typeof obj['addReadRoot'] === 'function' &&
    typeof obj['addWriteRoot'] === 'function' &&
    typeof obj['revokeRoot'] === 'function' &&
    typeof obj['getGrants'] === 'function'
  );
}
