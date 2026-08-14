/**
 * Credential resolution for the Telegram entrypoint.
 *
 * Extracted from `src/telegram.ts` so the auth-matrix decision is unit-testable
 * without booting a bot — previously it was reachable only by running the
 * daemon, because the entrypoint calls `main()` at module load.
 *
 * Contract: the decision is split from its effects on purpose.
 * {@link planTelegramCredential} is pure and returns what SHOULD happen;
 * {@link applyTelegramCredentialPlan} performs the `process.env` write, the
 * `config.apiKey` assignment, and the operator-facing logging. The entrypoint
 * owns `process.exit` — this module never exits the process.
 *
 * Auth matrix (matches the CLI exactly via `loadCredential()`):
 *   - Claude models: `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` → macOS
 *     Keychain entry `Claude Code-credentials` (populated by `claude
 *     setup-token` / any Claude Code sign-in). Token shape
 *     (`sk-ant-oat01-...` vs `sk-ant-api...`) is detected by `detectAuthMode`
 *     and routes to OAuth bearer auth or `x-api-key` header auth. Per-request
 *     401 refresh + write-back is owned by the provider via `tokenRefresher`.
 *   - Codex / OpenAI-compatible models: `OPENAI_API_KEY` / `CODEX_API_KEY`, or
 *     existing `codex login` state on disk.
 *   - xAI / Grok (`xai` / `xai-oauth`): `XAI_API_KEY` and/or SuperGrok OAuth
 *     store (`afk provider auth xai login`). OAuth tokens are never stashed into
 *     `config.apiKey` (same CLI invariant as session bootstrap).
 */

import { env } from '../config/env.js';
import { detectAuthMode } from '../agent/providers/anthropic-direct/auth.js';
import { loadXaiApiKey } from '../agent/auth/credential-resolver.js';
import { resolveXaiAuth } from '../agent/providers/xai/auth.js';
import { loadCredential } from '../cli/config.js';

/** The env var a resolved Anthropic credential is stashed into, by token shape. */
export type AnthropicAuthEnvVar = 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';

export type TelegramCredentialPlan =
  /** OpenAI-routed model: nothing to stash; the provider resolves its own key. */
  | { kind: 'openai'; notices: string[] }
  /**
   * xAI / Grok: optional metered key to thread onto config; OAuth stays in the
   * AFK store and is resolved inside `XaiProvider`.
   */
  | { kind: 'xai'; apiKey?: string; notices: string[] }
  /** Claude model with a resolved credential to stash + thread into config. */
  | { kind: 'anthropic'; credential: string; envVar: AnthropicAuthEnvVar; notices: string[] }
  /** No usable credential — the entrypoint must exit. */
  | { kind: 'missing'; errors: string[] };

/** Injectable seams so the auth matrix can be exercised without real credentials. */
export interface TelegramCredentialDeps {
  openaiApiKey?: string | undefined;
  codexApiKey?: string | undefined;
  loadAnthropicCredential?: () => string | undefined;
  loadXaiKey?: () => string | undefined;
  /** True when SuperGrok OAuth tokens are readable from the store. */
  hasXaiOAuth?: () => boolean;
  detectMode?: (token: string) => 'oauth' | 'api-key';
}

/** True for the provider names that route to an OpenAI-compatible endpoint. */
export function isOpenAiRoutedProvider(providerName: string): boolean {
  return providerName === 'openai-compatible' || providerName === 'openai-codex';
}

/** True for first-class xAI / Grok provider family. */
export function isXaiRoutedProvider(providerName: string): boolean {
  return providerName === 'xai' || providerName === 'xai-oauth';
}

function defaultHasXaiOAuth(): boolean {
  return resolveXaiAuth(undefined, 'oauth').apiKey != null;
}

/**
 * Decide which credential the Telegram bot should run on. Pure — performs no
 * env writes, no logging, and never exits (aside from deps that may read env).
 */
export function planTelegramCredential(
  providerName: string,
  deps: TelegramCredentialDeps = {},
): TelegramCredentialPlan {
  const {
    openaiApiKey = env.OPENAI_API_KEY,
    codexApiKey = env.CODEX_API_KEY,
    loadAnthropicCredential = loadCredential,
    loadXaiKey = loadXaiApiKey,
    hasXaiOAuth = defaultHasXaiOAuth,
    detectMode = detectAuthMode,
  } = deps;

  if (isOpenAiRoutedProvider(providerName)) {
    const openaiKey = openaiApiKey || codexApiKey;
    return {
      kind: 'openai',
      notices: [
        openaiKey
          ? '📝 Using OPENAI_API_KEY / CODEX_API_KEY for OpenAI auth'
          : // The openai-compatible provider also reads ~/.codex/auth.json when it
            // contains an API key (not ChatGPT OAuth). Surface that path here so the
            // operator knows what the resolver will try.
            '📝 Will attempt API key from ~/.codex/auth.json (run `afk provider auth diagnose` for details)',
      ],
    };
  }

  if (isXaiRoutedProvider(providerName)) {
    const forceOAuth = providerName === 'xai-oauth';
    const xaiKey = loadXaiKey();
    const keyOk = !!xaiKey && xaiKey.length > 0;
    const oauthOk = hasXaiOAuth();

    if (forceOAuth) {
      if (!oauthOk) {
        return {
          kind: 'missing',
          errors: [
            '❌ SuperGrok OAuth required for xai-oauth models.',
            '   Run `afk provider auth xai login` (device-code), then restart the bot.',
          ],
        };
      }
      return {
        kind: 'xai',
        notices: [
          '📝 Using SuperGrok / SuperGrok Heavy / X Premium+ OAuth for xAI',
        ],
      };
    }

    if (!keyOk && !oauthOk) {
      return {
        kind: 'missing',
        errors: [
          '❌ Grok models require XAI_API_KEY or SuperGrok OAuth.',
          '   Set XAI_API_KEY, or run `afk provider auth xai login`.',
        ],
      };
    }

    const notices: string[] = [];
    if (keyOk) notices.push('📝 Using XAI_API_KEY for metered xAI auth');
    if (oauthOk && !keyOk) {
      notices.push(
        '📝 Using SuperGrok / SuperGrok Heavy / X Premium+ OAuth for xAI',
      );
    } else if (oauthOk && keyOk) {
      notices.push(
        '📝 Both XAI_API_KEY and SuperGrok OAuth present — use slot provider xai vs xai-oauth if ambiguous',
      );
    }
    return {
      kind: 'xai',
      ...(keyOk ? { apiKey: xaiKey } : {}),
      notices,
    };
  }

  // Resolve via the same path the CLI uses: env vars first, then the macOS
  // keychain (Claude Code credentials). This avoids the historical bug where
  // the bot's manual env-var ladder didn't see tokens stashed in the keychain
  // by `claude setup-token`.
  const credential = loadAnthropicCredential();
  if (!credential || credential.length === 0) {
    return {
      kind: 'missing',
      errors: [
        '❌ Claude models require ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.',
        '   Set one in your environment, run `afk login`, or sign in to Claude Code.',
      ],
    };
  }

  const envVar: AnthropicAuthEnvVar =
    detectMode(credential) === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  return {
    kind: 'anthropic',
    credential,
    envVar,
    notices: [
      envVar === 'CLAUDE_CODE_OAUTH_TOKEN'
        ? '📝 Using CLAUDE_CODE_OAUTH_TOKEN for Anthropic auth (OAuth, auto-refresh on 401)'
        : '📝 Using ANTHROPIC_API_KEY for Anthropic auth',
    ],
  };
}

/**
 * Apply a {@link TelegramCredentialPlan}: stash the credential into the env var
 * matching its token shape, thread it onto `config.apiKey` so child sessions
 * created by `createSession` see the same token, and emit the operator notices.
 *
 * Returns false when the plan is `missing` — the caller exits, not this module.
 */
export function applyTelegramCredentialPlan(
  plan: TelegramCredentialPlan,
  config: { apiKey?: string | undefined },
  io: { log?: (message: string) => void; error?: (message: string) => void } = {},
): boolean {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;

  if (plan.kind === 'missing') {
    for (const line of plan.errors) error(line);
    return false;
  }

  if (plan.kind === 'anthropic') {
    // Stash into the env var that matches the token shape so downstream code
    // (including the provider's per-request 401 refresher) sees a consistent
    // signal. The provider re-checks shape internally via detectAuthMode — this
    // is for log clarity and any code path that reads env directly.
    process.env[plan.envVar] = plan.credential;
    config.apiKey = plan.credential;
  }

  if (plan.kind === 'xai') {
    // Only metered XAI_API_KEY is threaded onto config — never SuperGrok
    // access_token (ambiguous-auth footgun; XaiProvider owns the store).
    if (plan.apiKey !== undefined && plan.apiKey.length > 0) {
      config.apiKey = plan.apiKey;
    }
  }

  for (const line of plan.notices) log(line);
  return true;
}
