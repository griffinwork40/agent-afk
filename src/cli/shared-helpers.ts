import { providerForModel } from '../agent/providers/index.js';
import type { AgentModelInput, ThinkingConfig, EffortLevel } from '../agent/types.js';
import { loadOpenAICredential, resolveCredentialForModel } from '../agent/auth/credential-resolver.js';
import { env } from '../config/env.js';
import type { GrantManager } from './slash/commands/allow-dir.js';

export {
  composeSystemPrompt,
  loadConfigSystemPrompt,
  loadSystemPrompt,
  OPERATOR_CONFIG_HEADER,
  resolveBaseSystemPrompt,
} from './system-prompt.js';
export { parseProvider } from './provider-parser.js';
export type { ParseProviderOptions } from './provider-parser.js';

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
  if (raw === 'enabled:max') return { type: 'enabled', budgetTokens: Number.POSITIVE_INFINITY };
  const m = /^enabled:(\d+)$/.exec(raw);
  if (m) {
    const budgetTokens = parseInt(m[1]!, 10);
    if (Number.isNaN(budgetTokens)) throw new Error(`Invalid thinking budget: ${raw}`);
    return { type: 'enabled', budgetTokens };
  }
  throw new Error(`Invalid --thinking value: ${raw}. Expected 'adaptive' | 'disabled' | 'enabled:<N>' | 'enabled:max'`);
}

/** Valid effort levels. */
const VALID_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Parse effort level from string input. */
export function parseEffort(raw: string | undefined): EffortLevel | undefined {
  if (raw === undefined) return undefined;
  if ((VALID_EFFORT_LEVELS as readonly string[]).includes(raw)) return raw as EffortLevel;
  throw new Error(`Invalid --effort value: ${raw}. Expected one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
}

/** Get thinking mode from environment. */
export function getThinking(): ThinkingConfig | undefined {
  return parseThinking(env.AFK_THINKING);
}

/** Get effort level from environment. */
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

/** Read per-task budget hint from environment. */
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

/** Read max-output-tokens ceiling from environment. */
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
