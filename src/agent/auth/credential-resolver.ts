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

import { providerForModel } from '../providers/index.js';
import { loadClaudeCodeOauthToken } from './keychain.js';
import { env } from '../../config/env.js';

/**
 * Load an Anthropic credential from the environment or the Claude Code
 * keychain. Precedence:
 *   1. `ANTHROPIC_API_KEY` env
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` env
 *   3. macOS Keychain (`Claude Code-credentials`) / `~/.claude/.credentials.json`
 *
 * Returns `undefined` when no credential is available. Mirrors the body of
 * `loadCredential()` in `src/cli/config.ts`, which becomes a thin delegate
 * to this function.
 */
export function loadAnthropicCredential(): string | undefined {
  return (
    env.ANTHROPIC_API_KEY ||
    env.CLAUDE_CODE_OAUTH_TOKEN ||
    loadClaudeCodeOauthToken()
  );
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
 * Resolve a provider-appropriate credential for the given model string.
 *
 * Routing:
 *   - `openai-compatible` or `openai-codex` models → `OPENAI_API_KEY` /
 *     `CODEX_API_KEY` (never the Anthropic keychain).
 *   - All other models (Anthropic-routed) → `ANTHROPIC_API_KEY` /
 *     `CLAUDE_CODE_OAUTH_TOKEN` / Claude Code keychain.
 *
 * Invariant: preserves the cross-provider anti-leak invariant from PR #640.
 * Anthropic credentials (`sk-ant-…`) never reach OpenAI-routed models, and
 * OpenAI credentials never reach Anthropic-routed models.
 *
 * This is the relocated body of `getApiKeyForModel` from
 * `src/cli/shared-helpers.ts`, which becomes a thin delegate to this function.
 */
export function resolveCredentialForModel(model: string | undefined): string | undefined {
  const provider = providerForModel(model);
  return provider === 'openai-compatible' || provider === 'openai-codex'
    ? loadOpenAICredential()
    : loadAnthropicCredential();
}
