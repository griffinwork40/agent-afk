/**
 * Auth resolution for the `xai` provider (API key + SuperGrok / SuperGrok Heavy
 * / X Premium+ OAuth).
 *
 * Precedence (explicit mode first):
 *   force oauth (`xai-oauth` / forceXaiOAuth):
 *     stored SuperGrok tokens only
 *   force apikey (`xai` / forceApiKey):
 *     config.apiKey → XAI_API_KEY
 *   unforced (auto from grok-*):
 *     only key → apikey
 *     only OAuth → oauth
 *     both → ambiguous-auth (never silent pick)
 *     neither → no-usable-auth
 *
 * Never uses OPENAI_API_KEY. Never logs raw tokens (last4 only).
 *
 * @module agent/providers/xai/auth
 */

import { env } from '../../../config/env.js';
import {
  type XaiAuthStoreDeps,
  last4OfToken,
  readXaiTokens,
  type XaiTokenBundle,
} from './auth-store.js';
import type { XaiAuthMode } from './endpoints.js';
import { DEFAULT_XAI_API_BASE_URL, DEFAULT_XAI_OAUTH_BASE_URL } from './endpoints.js';

export type XaiAuthSource =
  | 'config'
  | 'env'
  | 'xai-oauth'
  | 'no-usable-auth'
  | 'no-usable-auth-forced-xai-oauth'
  | 'no-usable-auth-forced-xai-apikey'
  | 'ambiguous-auth';

export interface XaiAuthResolution {
  /** Bearer token or API key; null when the request must not proceed. */
  apiKey: string | null;
  source: XaiAuthSource;
  /** Effective mode when a credential was selected (or forced). */
  mode?: XaiAuthMode;
  last4?: string;
  /** Epoch seconds access-token expiry (oauth only). */
  expiresAt?: number;
  envVar?: 'XAI_API_KEY';
}

export interface XaiAuthResolverDeps {
  readEnv?: (key: string) => string | undefined;
  store?: XaiAuthStoreDeps;
  /** Epoch seconds clock (tests). */
  nowSeconds?: () => number;
}

export type XaiAuthForceMode = 'apikey' | 'oauth' | undefined;

function defaultReadEnv(key: string): string | undefined {
  if (key === 'XAI_API_KEY') return env.XAI_API_KEY;
  return undefined;
}

function hasApiKey(
  explicitConfigKey: string | undefined,
  readEnv: (k: string) => string | undefined,
): { key: string; source: 'config' | 'env' } | null {
  if (explicitConfigKey && explicitConfigKey.length > 0) {
    return { key: explicitConfigKey, source: 'config' };
  }
  const envKey = readEnv('XAI_API_KEY');
  if (envKey && envKey.length > 0) return { key: envKey, source: 'env' };
  return null;
}

function oauthFromStore(
  deps: XaiAuthResolverDeps,
): { bundle: XaiTokenBundle; last4: string } | null {
  const bundle = readXaiTokens(deps.store ?? {});
  if (!bundle) return null;
  return { bundle, last4: last4OfToken(bundle.access_token) };
}

/**
 * Resolve xAI credentials for the given force mode.
 *
 * @param explicitConfigKey - AgentConfig.apiKey when set
 * @param forceMode - `'apikey'` | `'oauth'` when provider/slot forces a mode;
 *   `undefined` = auto (ambiguous when both present)
 */
export function resolveXaiAuth(
  explicitConfigKey: string | undefined,
  forceMode: XaiAuthForceMode = undefined,
  deps: XaiAuthResolverDeps = {},
): XaiAuthResolution {
  const readEnv = deps.readEnv ?? defaultReadEnv;
  const keyHit = hasApiKey(explicitConfigKey, readEnv);
  const oauthHit = oauthFromStore(deps);

  if (forceMode === 'oauth') {
    if (oauthHit) {
      return {
        apiKey: oauthHit.bundle.access_token,
        source: 'xai-oauth',
        mode: 'oauth',
        last4: oauthHit.last4,
        expiresAt: oauthHit.bundle.expires_at,
      };
    }
    return { apiKey: null, source: 'no-usable-auth-forced-xai-oauth', mode: 'oauth' };
  }

  if (forceMode === 'apikey') {
    if (keyHit) {
      return {
        apiKey: keyHit.key,
        source: keyHit.source,
        mode: 'apikey',
        last4: last4OfToken(keyHit.key),
        ...(keyHit.source === 'env' ? { envVar: 'XAI_API_KEY' as const } : {}),
      };
    }
    return { apiKey: null, source: 'no-usable-auth-forced-xai-apikey', mode: 'apikey' };
  }

  // Auto: only one family wins; both → ambiguous; neither → empty.
  if (keyHit && oauthHit) {
    return { apiKey: null, source: 'ambiguous-auth' };
  }
  if (keyHit) {
    return {
      apiKey: keyHit.key,
      source: keyHit.source,
      mode: 'apikey',
      last4: last4OfToken(keyHit.key),
      ...(keyHit.source === 'env' ? { envVar: 'XAI_API_KEY' as const } : {}),
    };
  }
  if (oauthHit) {
    return {
      apiKey: oauthHit.bundle.access_token,
      source: 'xai-oauth',
      mode: 'oauth',
      last4: oauthHit.last4,
      expiresAt: oauthHit.bundle.expires_at,
    };
  }
  return { apiKey: null, source: 'no-usable-auth' };
}

function formatExpiry(expiresAt?: number, nowSeconds?: () => number): string {
  if (typeof expiresAt !== 'number') return '';
  const now = (nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const secondsLeft = expiresAt - now;
  if (secondsLeft <= 0) {
    return ', EXPIRED — re-run `afk provider auth xai login`';
  }
  const h = Math.floor(secondsLeft / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  return `, expires in ${h > 0 ? `${h}h ` : ''}${m}m`;
}

/**
 * One-line diagnostic for `afk provider auth diagnose` / init errors.
 * Never includes raw token material.
 */
export function formatXaiAuthDiagnostic(
  resolution: XaiAuthResolution,
  deps: { nowSeconds?: () => number } = {},
): string {
  switch (resolution.source) {
    case 'config':
      return `using explicit AFK config xAI API key (…${resolution.last4 ?? '????'})`;
    case 'env':
      return `using XAI_API_KEY env var (…${resolution.last4 ?? '????'})`;
    case 'xai-oauth': {
      const expiry = formatExpiry(resolution.expiresAt, deps.nowSeconds);
      return (
        `using SuperGrok / SuperGrok Heavy / X Premium+ OAuth (…${resolution.last4 ?? '????'}${expiry})`
      );
    }
    case 'no-usable-auth-forced-xai-oauth':
      return (
        "This model's slot/provider is `xai-oauth` but no SuperGrok OAuth tokens were found. " +
        'Run `afk provider auth xai login` (device-code by default), or switch to `xai` with XAI_API_KEY.'
      );
    case 'no-usable-auth-forced-xai-apikey':
      return (
        "This model's slot/provider is `xai` (API-key mode) but no XAI_API_KEY / config key was found. " +
        'Set XAI_API_KEY, or use `xai-oauth` after `afk provider auth xai login`.'
      );
    case 'ambiguous-auth':
      return (
        'Both XAI_API_KEY and SuperGrok OAuth tokens are present. Choose explicitly: ' +
        '`--provider xai` (API key → ' +
        DEFAULT_XAI_API_BASE_URL +
        ') or `--provider xai-oauth` (subscription OAuth → ' +
        DEFAULT_XAI_OAUTH_BASE_URL +
        ').'
      );
    case 'no-usable-auth':
    default:
      return (
        'No xAI auth found. Set XAI_API_KEY for metered API access, or run ' +
        '`afk provider auth xai login` for SuperGrok / SuperGrok Heavy / X Premium+.'
      );
  }
}

/**
 * Human-readable guidance for HTTP 402 / 403 after OAuth login.
 * Never includes tokens.
 */
export function formatXaiHttpAuthError(
  status: number,
  opts: {
    mode: XaiAuthMode;
    baseURL?: string;
    bodySnippet?: string;
  },
): string {
  const base = opts.baseURL ?? (opts.mode === 'oauth' ? DEFAULT_XAI_OAUTH_BASE_URL : DEFAULT_XAI_API_BASE_URL);
  const snippet = (opts.bodySnippet ?? '').slice(0, 180);

  if (status === 402) {
    return (
      `xAI returned HTTP 402 on ${base}` +
      (snippet ? ` (${snippet})` : '') +
      '. This is usually a subscription/spend gate (e.g. personal-team-blocked), not a missing login. ' +
      'Check SuperGrok / SuperGrok Heavy / X Premium+ status, try the other endpoint via ' +
      'AFK_XAI_OAUTH_BASE_URL or AFK_XAI_BASE_URL, or use a metered XAI_API_KEY with `--provider xai`.'
    );
  }

  if (status === 403) {
    return (
      `xAI returned HTTP 403 on ${base}` +
      (snippet ? ` (${snippet})` : '') +
      '. After SuperGrok OAuth login this often means the account lacks OAuth API entitlement, ' +
      'the model requires SuperGrok Heavy, or traffic hit api.x.ai instead of the CLI chat proxy. ' +
      `Try AFK_XAI_OAUTH_BASE_URL=${DEFAULT_XAI_OAUTH_BASE_URL} (default for xai-oauth), ` +
      'or fall back to XAI_API_KEY with `--provider xai`.'
    );
  }

  return `xAI returned HTTP ${status} on ${base}` + (snippet ? `: ${snippet}` : '');
}
