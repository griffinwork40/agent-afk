/**
 * Per-model credential resolver for the agent layer.
 *
 * This module lives in `src/agent/auth/` so the executor layer
 * (`src/agent/tools/`) can import it directly — eliminating the injection
 * threading that previously threaded `resolveApiKeyForModel` through 8
 * production files because the resolver used to live in `src/cli/`.
 *
 * History: `getApiKeyForModel` / `loadCredential` / `getCodexApiKey` were
 * defined in `src/cli/shared-helpers.ts` and `src/cli/config.ts`. Because
 * `src/agent/` must never import from `src/cli/` (layering invariant), the
 * resolver had to be passed as an injected function into every executor
 * context. Moving it to `src/agent/auth/` removes that constraint. The CLI
 * modules now re-export thin delegates so every existing caller and test
 * continues to work unchanged.
 *
 * Cross-provider anti-leak invariant (PR #640): Anthropic credentials
 * (`sk-ant-…`) must NEVER reach OpenAI-routed children, and OpenAI keys
 * must never reach Anthropic children. `resolveCredentialForModel` enforces
 * this by gating on `providerForModel(model)` — preserved exactly from the
 * original `getApiKeyForModel`.
 */

import { providerForModel, type ProviderRouteHints } from '../providers/index.js';
import { loadClaudeCodeOauthToken, refreshClaudeCodeOauthToken } from './keychain.js';
import { env } from '../../config/env.js';

// Process-local fallback for a successfully refreshed token whose persistent
// credential-store write-back failed. Keeping it in the resolver makes the
// token available to every subsequent CLI credential read in this process.
let refreshedClaudeCodeOauthToken: string | undefined;

// #4882: the last Anthropic credential a normal (foreground) resolution
// produced. Read by the fork-time credential-source path, which must never
// spawn the keychain reader. Process-local; never logged or persisted.
let lastResolvedAnthropic: AnthropicCredential | undefined;

/**
 * Load an Anthropic credential from the environment or the Claude Code
 * keychain. Precedence:
 *   1. `ANTHROPIC_API_KEY` env
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` env
 *   3. macOS Keychain (`Claude Code-credentials`) / `~/.claude/.credentials.json`
 *   4. A token refreshed during this process (write-back fallback)
 *
 * Invariant: the live store MUST outrank the process-local cache. The cache is
 * populated on EVERY startup preload — `refreshClaudeCodeOauthToken` returns the
 * current access token even when no network refresh was needed (token not yet
 * near-expiry) — so ranking it above the store pinned every later read to the
 * boot-time account: after the operator ran `claude login` to switch accounts
 * and the turn-start credential catch-up swapped the parent to the new account
 * (its refresher reads the store directly) while every forked subagent resolved
 * the stale boot token here and died on the old account's 429. The cache is only a fallback for when the
 * store yields no valid token (write-back failed and the stored one is expired).
 *
 * Returns `undefined` when no credential is available. Token-only projection of
 * {@link resolveAnthropicCredential}, which owns the precedence walk; callers
 * that also need provenance should call that directly. `loadCredential()` in
 * `src/cli/config.ts` is a thin delegate to this function.
 */
export function loadAnthropicCredential(): string | undefined {
  return resolveAnthropicCredential()?.token;
}

/** Stable machine-readable id for the Anthropic credential tier that won. */
export type CredentialSourceId =
  | 'ANTHROPIC_API_KEY'
  | 'CLAUDE_CODE_OAUTH_TOKEN'
  | 'claude-code-keychain'
  | 'claude-code-session-refresh';

/** An Anthropic credential paired with the tier that produced it. */
export interface AnthropicCredential {
  token: string;
  source: CredentialSourceId;
}

/**
 * The single Anthropic precedence walk (see {@link loadAnthropicCredential}
 * for the order and the store-outranks-cache invariant, #2469). Returns the
 * selected token TOGETHER with its provenance, so callers that need both never
 * re-walk the chain and can never disagree with the loader (#4778). Mirrors the
 * `{ apiKey, source }` shape of `resolveOpenAIAuth()`.
 *
 * Returns `undefined` when no tier yields a credential. Never logs the token.
 */
export function resolveAnthropicCredential(): AnthropicCredential | undefined {
  const cred = resolveAnthropicCredentialFromEnv() ?? resolveAnthropicFromStore();
  if (cred) lastResolvedAnthropic = cred;
  return cred;
}

function resolveAnthropicFromStore(): AnthropicCredential | undefined {
  const stored = loadClaudeCodeOauthToken();
  if (stored) return { token: stored, source: 'claude-code-keychain' };
  if (refreshedClaudeCodeOauthToken) {
    return { token: refreshedClaudeCodeOauthToken, source: 'claude-code-session-refresh' };
  }
  return undefined;
}

/** The env tiers only (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`): no I/O. */
export function resolveAnthropicCredentialFromEnv(): AnthropicCredential | undefined {
  if (env.ANTHROPIC_API_KEY) return { token: env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { token: env.CLAUDE_CODE_OAUTH_TOKEN, source: 'CLAUDE_CODE_OAUTH_TOKEN' };
  }
  return undefined;
}

/**
 * The last credential {@link resolveAnthropicCredential} produced in this
 * process, or `undefined`. Never touches the credential store (#4882).
 */
export function lastResolvedAnthropicCredential(): AnthropicCredential | undefined {
  return lastResolvedAnthropic;
}

/** Reset the last-resolved memo. Intended for isolated tests. */
export function _resetLastResolvedAnthropicCredential(): void {
  lastResolvedAnthropic = undefined;
}

/**
 * Startup preload for the Claude Code keychain OAuth token.
 *
 * Refreshes a near-expiry / expired keychain OAuth access token and writes it
 * back to the store BEFORE a synchronous credential read, but only when that
 * keychain entry is the credential that will actually be used: an
 * Anthropic-routed provider with no env credential (`ANTHROPIC_API_KEY` /
 * `CLAUDE_CODE_OAUTH_TOKEN` take precedence and never need a refresh).
 *
 * The guard matters for two reasons the unconditional call did not handle:
 *   1. OpenAI / xAI / local users, and Anthropic users already authenticated
 *      via an env var, never read this keychain entry — so refreshing it is
 *      dead work (a `security` subprocess on macOS) and can print a spurious
 *      "OAuth token expired" warning from a stale `claude login` entry.
 *   2. It keeps a network refresh off the startup path for those users.
 *
 * Returns the fresh access token when a refresh occurred and produced one, so
 * callers can use it as a fallback if the write-back to the credential store
 * failed (locked / read-only keychain); returns `undefined` when the guard
 * skipped the refresh or no token was available. Never throws.
 */
export async function preloadClaudeKeychainOAuth(
  provider: string,
): Promise<string | undefined> {
  if (provider !== 'anthropic-direct') return undefined;
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return undefined;
  const token = await refreshClaudeCodeOauthToken();
  if (token) refreshedClaudeCodeOauthToken = token;
  return token;
}

/** Reset the process-local refresh fallback. Intended for isolated tests. */
export function _resetRefreshedClaudeCodeOauthToken(): void {
  refreshedClaudeCodeOauthToken = undefined;
}

/**
 * Update the process-local refresh fallback with a freshly-obtained token.
 *
 * Called by `forceClientRefresh()` (via the turn-start credential catch-up or
 * the usage-limit hot-swap path) after it successfully builds a new SDK client.
 * Keeps the resolver cache in sync so that when the live credential store
 * yields nothing (expired token, write-back failed, locked keychain),
 * `loadAnthropicCredential()` returns the freshly-refreshed token —
 * i.e. the account the parent is NOW authenticated with — rather than
 * the boot-time token.
 *
 * Never logs or persists the token value.
 */
export function setRefreshedClaudeCodeOauthToken(token: string): void {
  refreshedClaudeCodeOauthToken = token;
}

/**
 * Get a Codex-compatible (OpenAI) API key from the environment, if present.
 * Precedence: `OPENAI_API_KEY` → `CODEX_API_KEY`.
 *
 * Returns `undefined` when neither is set. Mirrors `getCodexApiKey()` in
 * `src/cli/shared-helpers.ts`, which becomes a thin delegate to this function.
 */
export function loadOpenAICredential(): string | undefined {
  return env.OPENAI_API_KEY || env.CODEX_API_KEY || undefined;
}

/**
 * Metered xAI API key from the environment only (`XAI_API_KEY`).
 *
 * Invariant: SuperGrok / SuperGrok Heavy / X Premium+ OAuth access tokens are
 * NEVER returned here. Session bootstrap injects this value into
 * `AgentConfig.apiKey`; if an OAuth access_token were placed there,
 * `resolveXaiAuth(config.apiKey, 'auto')` would treat it as an API key while
 * also seeing the OAuth store → false `ambiguous-auth`. OAuth stays in the
 * token store and is resolved only inside `XaiProvider`.
 *
 * Never returns OPENAI_API_KEY / Anthropic credentials.
 */
export function loadXaiApiKey(): string | undefined {
  const k = env.XAI_API_KEY;
  return k && k.length > 0 ? k : undefined;
}

/**
 * Resolve a provider-appropriate credential for the given model string.
 *
 * Routing:
 *   - `openai-compatible` or `openai-codex` models → `OPENAI_API_KEY` /
 *     `CODEX_API_KEY` (never the Anthropic keychain).
 *   - `xai` / `xai-oauth` → `XAI_API_KEY` only (never SuperGrok OAuth tokens;
 *     never OpenAI keys). OAuth is owned by `XaiProvider` + the xAI store.
 *   - All other models (Anthropic-routed) → `ANTHROPIC_API_KEY` /
 *     `CLAUDE_CODE_OAUTH_TOKEN` / Claude Code keychain.
 *
 * Invariant: preserves the cross-provider anti-leak invariant from PR #640.
 * Anthropic credentials (`sk-ant-…`) never reach OpenAI-routed models, and
 * OpenAI credentials never reach Anthropic-routed models. xAI never receives
 * OPENAI_API_KEY either.
 *
 * Contract: pass `hints.explicit` (CLI `--provider`) so credential family
 * matches the selected provider, not only the model id. Without that,
 * `afk chat --provider xai -m sonnet` injects an Anthropic key into
 * `AgentConfig.apiKey` and forced-apikey xAI mode would send it to api.x.ai.
 * `AFK_PROVIDER` is already read by {@link providerForModel} when hints omit
 * `explicit`.
 *
 * This is the relocated body of `getApiKeyForModel` from
 * `src/cli/shared-helpers.ts`, which becomes a thin delegate to this function.
 */
export function resolveCredentialForModel(
  model: string | undefined,
  hints?: ProviderRouteHints,
): string | undefined {
  const provider = providerForModel(model, hints);
  if (provider === 'openai-compatible' || provider === 'openai-codex') {
    return loadOpenAICredential();
  }
  if (provider === 'xai' || provider === 'xai-oauth') {
    return loadXaiApiKey();
  }
  return loadAnthropicCredential();
}
