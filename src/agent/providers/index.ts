/**
 * Provider registry + model-based routing.
 *
 * Two bundled providers:
 *   - `anthropic-direct` — wraps `@anthropic-ai/sdk` Messages API directly.
 *     Default for all Claude models. `'anthropic'` is a silent alias.
 *   - `openai-compatible` — talks directly to OpenAI's Chat Completions API
 *     (and any compatible endpoint via baseURL). Default for GPT/o-series
 *     models AND any HF-style `org/model` id (mlx-community/…, TheBloke/…,
 *     Qwen/…) — those are served exclusively by local OpenAI-shim runners
 *     (MLX, llama.cpp, vLLM, ollama-openai) and Anthropic ids never contain
 *     `/`. Replaced the legacy `openai-codex` provider (which wrapped
 *     `@openai/codex-sdk` and ran a harness-in-harness — slice 5 of the
 *     2026-05-18 provider refactor).
 *
 * Callers may still inject a fully custom provider via `AgentConfig.provider`;
 * the router is only consulted when no explicit provider is supplied.
 *
 * @module agent/providers
 */

import type { ModelProvider } from '../provider.js';
import { anthropicDirectProvider, AnthropicDirectProvider } from './anthropic-direct/index.js';
import { OpenAICompatibleProvider } from './openai-compatible/index.js';
import { MODEL_MAP } from '../session/model-resolution.js';
import { resolveBinding, type ModelSlots } from '../session/model-slots.js';
import { env } from '../../config/env.js';

/**
 * Short aliases that route to the `anthropic-direct` provider.
 *
 * Since `providerForModel` now resolves slot aliases to their concrete bound
 * id *before* consulting this set, the load-bearing entry is `'auto'` — the
 * model-router sentinel that resolves to itself (no fixed id; the provider
 * selects the model dynamically at run time). The `MODEL_MAP`-derived keys are
 * a defensive fallback: under default bindings a resolved alias like `sonnet`
 * becomes `claude-sonnet-4-6` and routes via the `claude-` prefix below, so
 * those keys are not normally hit. Kept (and derived from `MODEL_MAP` to avoid
 * drift) so any path that bypasses resolution still locks to Anthropic.
 */
const CLAUDE_SHORT_ALIASES = new Set([
  ...Object.keys(MODEL_MAP),
  // 'auto' is a model-router sentinel — not a fixed ID, no MODEL_MAP entry.
  'auto',
]);

/**
 * Provider names bundled with the harness.
 *
 * Backward-compat note: `'openai-codex'` is **deprecated** as of the
 * sibling-provider refactor (slices 1-5, 2026-05-18) — the legacy
 * `@openai/codex-sdk`-backed provider has been removed and `'openai-codex'`
 * now resolves to the same `OpenAICompatibleProvider` instance as
 * `'openai-compatible'`. Kept in the union so existing user scripts and
 * configs that pass `--provider openai-codex` keep working. Will be
 * removed in a future major release.
 */
export type BundledProviderName =
  | 'anthropic'
  | 'anthropic-direct'
  | 'openai-compatible'
  | 'openai-codex'; // deprecated alias for openai-compatible

/**
 * Optional context for {@link providerForModel}. When omitted, env vars fill
 * in: `AFK_PROVIDER` → `explicit`, `AFK_OPENAI_BASE_URL` → `openaiBaseUrl`.
 * Tests pass explicit hints to bypass `process.env` and stay hermetic.
 */
export interface ProviderRouteHints {
  /**
   * Forced provider name from `--provider` flag or `AFK_PROVIDER` env. Accepts
   * any case + the aliases recognized at the CLI (`anthropic`, `openai`,
   * `openai-codex`). Always wins when set. Empty / whitespace / unrecognized
   * values are ignored.
   */
  explicit?: string;
  /**
   * Base URL for the OpenAI-compatible endpoint (e.g. `AFK_OPENAI_BASE_URL`).
   * Truthy presence of this value causes unknown model names to route to
   * `openai-compatible` (Tier 4 below) — fixes the
   * `AFK_OPENAI_BASE_URL=… AFK_MODEL=deepseek-v4-pro` → 404 footgun where
   * the request previously went silently to api.anthropic.com.
   */
  openaiBaseUrl?: string;
  /**
   * Explicit model-slot bindings override. When omitted, the process-global
   * bindings installed by `loadConfig()` (or defaults+env) are used. Tests pass
   * this to route against a rebound tier table without mutating module state.
   */
  slots?: ModelSlots;
}

/**
 * Normalize an explicit provider string. Mirrors the alias table in
 * `cli/shared-helpers.ts:parseProvider` so `--provider` and `AFK_PROVIDER`
 * accept the same surface. Unknown / empty values return `undefined` so the
 * caller falls through to model-pattern routing instead of throwing — env
 * vars are best-effort hints, not hard contracts.
 */
function normalizeExplicitProvider(raw: string | undefined): BundledProviderName | undefined {
  if (!raw) return undefined;
  const lowered = raw.trim().toLowerCase();
  if (!lowered) return undefined;
  if (lowered === 'anthropic' || lowered === 'anthropic-direct') return 'anthropic-direct';
  if (
    lowered === 'openai' ||
    lowered === 'openai-compatible' ||
    lowered === 'openai-codex' // deprecated alias, still accepted
  ) {
    return 'openai-compatible';
  }
  return undefined;
}

/**
 * Decide which bundled provider to use for a given model string.
 *
 * Tier order (highest wins):
 *   1. **Explicit override** — `hints.explicit` (from `--provider` flag) or
 *      `AFK_PROVIDER` env var. Always wins. Unrecognized values fall through.
 *   2. **Claude lock** — applied to the *resolved* id (slot aliases are
 *      expanded first): `claude-*`, `claude_*`, `local-*` (PR #239
 *      Anthropic-compatible shim path), and the `auto` sentinel. Beats the
 *      env-hint tier so `AFK_OPENAI_BASE_URL=… afk -m sonnet` still routes to
 *      Anthropic when `sonnet` is bound to a Claude id (the default). If the
 *      user rebinds a tier to a non-Anthropic id, the resolved id falls through
 *      to Tier 3/4 and routes accordingly.
 *   3. **OpenAI patterns** — `gpt-*`, `o[134]*`, `codex-*`, plus common
 *      third-party shims (`deepseek-*`, `mistral-*`, `mixtral-*`, `llama-*`,
 *      `qwen-*`) and HF-style `org/model` ids.
 *   4. **Env hint** — `AFK_OPENAI_BASE_URL` set + unrecognized model name
 *      → `openai-compatible`. Catches arbitrary proxy model names
 *      (`deepseek-v4-pro`, etc.) without requiring `--provider`.
 *   5. **Legacy fallback** — `anthropic-direct`.
 *
 * @param hints Optional routing context. When omitted, `process.env` fills
 *   in (`AFK_PROVIDER`, `AFK_OPENAI_BASE_URL`). Tests pass explicit hints to
 *   stay hermetic — no env mocking required at the call site.
 */
export function providerForModel(
  model: string | undefined,
  hints?: ProviderRouteHints,
): BundledProviderName {
  // Read env defaults when hints not supplied. Keeping providerForModel
  // env-aware (rather than threading hints through ~25 call sites) was a
  // deliberate Option A trade-off — the function reads env on every call
  // (matching `env.AFK_*` getter semantics) so tests that mutate process.env
  // see the new value immediately, and callers don't need to plumb hints.
  // Going through `env.AFK_*` (not raw `process.env[...]`) keeps the
  // `audit-env-access` CI gate happy.
  const explicitRaw = hints?.explicit ?? env.AFK_PROVIDER;
  const openaiBaseUrl = hints?.openaiBaseUrl ?? env.AFK_OPENAI_BASE_URL;

  // Tier 1: explicit always wins
  const explicit = normalizeExplicitProvider(explicitRaw);
  if (explicit) return explicit;

  // Resolve slot aliases / custom names → the full binding BEFORE any pattern
  // matching, so a tier rebound to a non-Anthropic model (e.g. small→gpt-4o-mini)
  // routes to the correct provider. This is the resolution-before-routing step:
  // every raw call site of providerForModel (subagent dispatch, nesting
  // childProviderFactory, CLI/Telegram surfaces) gets correct routing for free
  // without per-site changes. Idempotent: full ids and the `auto` sentinel pass
  // through unchanged.
  const binding = resolveBinding(model, hints?.slots);

  // Per-slot explicit provider override (Stage 2). Honored after the global
  // --provider / AFK_PROVIDER tier but before id inference, so a tier bound to
  // a bare id on a shim (no gpt-/org-model signal) still routes to its declared
  // provider rather than defaulting to anthropic-direct.
  if (binding.provider === 'anthropic') return 'anthropic-direct';
  if (binding.provider === 'openai') return 'openai-compatible';

  // Tier 2: Claude lock (beats env-hint tier — see Tier 4 docstring), applied
  // to the resolved bound id.
  const lowered = binding.id.trim().toLowerCase();
  if (lowered) {
    if (CLAUDE_SHORT_ALIASES.has(lowered)) return 'anthropic-direct';
    if (lowered.startsWith('claude-') || lowered.startsWith('claude_')) return 'anthropic-direct';
    // `local-*` ids route through anthropic-direct + AFK_LOCAL_BASE_URL
    // (PR #239 Anthropic-compatible-shim path). Pinning them explicitly
    // here prevents Tier 4's env-hint from misrouting them when the user
    // has both AFK_LOCAL_BASE_URL and AFK_OPENAI_BASE_URL set (e.g. running
    // an Anthropic shim AND an OpenAI shim simultaneously).
    if (lowered.startsWith('local-') || lowered.startsWith('local_')) return 'anthropic-direct';
  }

  // Tier 3: known OpenAI-compatible patterns
  if (lowered) {
    if (
      lowered.startsWith('gpt-') ||
      lowered.startsWith('gpt_') ||
      lowered.startsWith('o1') ||
      lowered.startsWith('o3') ||
      lowered.startsWith('o4') ||
      lowered.startsWith('codex-') ||
      lowered.startsWith('codex_') ||
      lowered === 'codex' ||
      // Common third-party OpenAI-shim model families. These names ship from
      // providers like opencode.ai, OpenRouter, Together, Fireworks, DeepSeek,
      // Mistral, and Meta's Llama API — all of which expose an OpenAI Chat
      // Completions-shaped endpoint. Without these prefixes, an operator
      // running `AFK_MODEL=deepseek-v4-pro afk` (no AFK_OPENAI_BASE_URL set
      // → no Tier 4 fallback) silently 404s against api.anthropic.com.
      lowered.startsWith('deepseek-') ||
      lowered.startsWith('deepseek_') ||
      lowered.startsWith('mistral-') ||
      lowered.startsWith('mistral_') ||
      lowered.startsWith('mixtral-') ||
      lowered.startsWith('mixtral_') ||
      lowered.startsWith('llama-') ||
      lowered.startsWith('llama_') ||
      lowered.startsWith('qwen-') ||
      lowered.startsWith('qwen_')
    ) {
      return 'openai-compatible';
    }
    // HuggingFace-style `org/model` ids (mlx-community/…, TheBloke/…, Qwen/…)
    // are served exclusively by local OpenAI-shim servers (MLX-server,
    // llama.cpp, vLLM, ollama-openai). Anthropic model ids never contain `/`.
    if (lowered.includes('/')) return 'openai-compatible';
  }

  // Tier 3.5: a per-slot `baseUrl` on a tier whose id matched no Anthropic
  // signal above (claude-* / local-* / short-aliases all return at Tier 2) is a
  // strong signal the tier targets an OpenAI-compatible local shim (Ollama, LM
  // Studio, vLLM, MLX). Without this, an env-configured `local` slot — e.g.
  // AFK_MODEL_LOCAL=llama3.2:3b + AFK_MODEL_LOCAL_BASE_URL=http://localhost:11434/v1
  // — whose id matches no Tier-3 prefix would misroute to anthropic-direct and
  // POST the shim URL as an Anthropic Messages call. The env path cannot set the
  // explicit `provider` field, so a per-slot baseUrl is the only routing signal
  // available there. Anthropic-compatible shims are still reachable via a
  // `local-*` id (Tier 2) or an explicit `provider: 'anthropic'` (handled above).
  if (binding.baseUrl && binding.baseUrl.trim()) return 'openai-compatible';

  // Tier 4: env-hint fallback for unknown names. `AFK_OPENAI_BASE_URL` being
  // set is a strong signal the operator is targeting an OpenAI-compatible
  // endpoint — closes the "deepseek-v4-pro on opencode.ai/zen" footgun where
  // the request previously went to api.anthropic.com and 404'd.
  if (openaiBaseUrl && openaiBaseUrl.trim()) return 'openai-compatible';

  // Tier 5: legacy fallback
  return 'anthropic-direct';
}

/**
 * Resolve a concrete {@link ModelProvider} instance for a given model string.
 * Used by `AgentSession` when `config.provider` is not explicitly set.
 *
 * `'anthropic'` is a silent alias for `'anthropic-direct'`.
 * `'openai-codex'` is a deprecated silent alias for `'openai-compatible'`.
 *
 * **Per-session isolation:** both bundled providers construct a *fresh*
 * instance on every call. They hold mutable per-session state (the
 * `_sharedReadRoots` / `_sharedWriteRoots` / `_initialResolveBase` arrays
 * used by the `/allow-dir` GrantManager interface) that MUST NOT be shared
 * across concurrent sessions. Sharing a module-scope singleton previously
 * caused cross-session root leakage under `afk farm new N` (N > 1).
 *
 * Construction is cheap (no SDK handshake, no I/O) so allocating a fresh
 * provider per session is preferable to threading sessionId into every
 * shared-state read site.
 */
export function resolveProvider(
  model: string | undefined,
  hints?: ProviderRouteHints,
): ModelProvider {
  const name = providerForModel(model, hints);
  switch (name) {
    case 'openai-compatible':
    case 'openai-codex':
      // IMPORTANT: fresh instance per session — see docstring above.
      return new OpenAICompatibleProvider();
    case 'anthropic':
    case 'anthropic-direct':
    default:
      // IMPORTANT: fresh instance per session — see docstring above.
      return new AnthropicDirectProvider();
  }
}

export { anthropicDirectProvider };
export { AnthropicDirectProvider } from './anthropic-direct/index.js';
export { OpenAICompatibleProvider, openaiCompatibleProvider } from './openai-compatible/index.js';
