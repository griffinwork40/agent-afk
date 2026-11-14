/**
 * Provider-aware credential provenance (#4882).
 *
 * Contract: returns a stable, token-free id naming the credential that serves
 * `model`, chosen by the provider that actually serves it. A consumer (the Q
 * ledger) classifies billing from the id alone, so a WRONG id is a
 * money-reporting bug while an absent id only means "not recorded": every
 * uncertain case returns `undefined` rather than a guess.
 *
 *   Anthropic (unprefixed, unchanged since #4779):
 *     'ANTHROPIC_API_KEY'            metered API key
 *     'CLAUDE_CODE_OAUTH_TOKEN'      subscription login (env token)
 *     'claude-code-keychain'         subscription login (Claude Code store)
 *     'claude-code-session-refresh'  subscription login (refreshed this process)
 *     'anthropic:config'             metered (per-slot API key)
 *   OpenAI-compatible:
 *     'openai:env' | 'openai:config' | 'openai:codex-cli'  metered API key
 *     'openai:chatgpt-oauth'                             subscription login
 *   xAI:
 *     'xai:env' | 'xai:config'   metered API key
 *     'xai:oauth'                subscription login (SuperGrok)
 *   Endpoint overrides (slot `baseUrl`, `AFK_LOCAL_BASE_URL`,
 *   `AFK_OPENAI_BASE_URL`, `AFK_XAI_BASE_URL`, `AFK_XAI_OAUTH_BASE_URL`),
 *   classified by host (see credential-endpoint.ts):
 *     the provider's official API host  normal resolution (ids above)
 *     'local'            self-hosted host (loopback, RFC1918, link-local,
 *                        100.64/10, fc00::/7, single-label, .local/.lan/
 *                        .internal/.home.arpa/.ts.net): no cash cost
 *     'custom-endpoint'  any other host, or an unparseable URL: billing
 *                        unknown (a hosted service such as OpenRouter)
 *
 * Fork-time callers pass `noStoreRead`: the Anthropic tier then comes from the
 * env tiers or the memo of the last foreground resolution, never from the
 * credential store (no `security` spawn, no keychain backoff). OpenAI and xAI
 * resolution only read env and small files, never spawn.
 *
 * Ids only: no token material, suffix or last4 ever leaves this module.
 *
 * @module agent/auth/credential-source
 */

import { providerForModel, type ProviderRouteHints } from '../providers/index.js';
import { resolveBinding } from '../session/model-slots.js';
import { resolveOpenAIAuth } from '../providers/openai-compatible/auth.js';
import { resolveXaiAuth } from '../providers/xai/auth.js';
import {
  lastResolvedAnthropicCredential,
  resolveAnthropicCredential,
  resolveAnthropicCredentialFromEnv,
  type AnthropicCredential,
} from './credential-resolver.js';
import { classifyEndpoint, OFFICIAL_API_HOSTS } from './credential-endpoint.js';
import { env } from '../../config/env.js';

/** Fixed id for a clearly self-hosted endpoint (no cash cost). */
export const LOCAL_CREDENTIAL_SOURCE = 'local';
/** Fixed id for a hosted non-official endpoint (billing unknown). */
export const CUSTOM_ENDPOINT_CREDENTIAL_SOURCE = 'custom-endpoint';

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Options for {@link credentialSourceForModel}. */
export interface CredentialSourceOptions {
  /**
   * Fork / per-dispatch callers: never read the Claude Code credential store
   * (it may spawn `security` on macOS). Uses env tiers, then the memo of the
   * last foreground resolution, else no id.
   */
  noStoreRead?: boolean;
  /**
   * The explicit `apiKey` the session will actually send (e.g. a child
   * config key or a compose node key). When set, the recorded id must name
   * THIS key: Anthropic ids are emitted only when the key equals the resolved
   * tier's token; OpenAI/xAI treat it as their explicit-config tier, exactly
   * as their providers do.
   */
  configApiKey?: string;
  /** The Anthropic-semantic `baseUrl` the session will actually use, if any. */
  configBaseUrl?: string;
}

const SUBSCRIPTION_TIERS: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN', 'claude-code-keychain', 'claude-code-session-refresh',
]);

type EndpointFamily = keyof typeof OFFICIAL_API_HOSTS;

/** `undefined` = official or no override (resolve normally); else the fixed id. */
function endpointOverrideId(url: string | undefined, family: EndpointFamily): string | undefined {
  if (!nonEmpty(url)) return undefined;
  const cls = classifyEndpoint(url, OFFICIAL_API_HOSTS[family]);
  if (cls === 'official') return undefined;
  return cls === 'local' ? LOCAL_CREDENTIAL_SOURCE : CUSTOM_ENDPOINT_CREDENTIAL_SOURCE;
}

function explicitProviderRaw(hints: ProviderRouteHints | undefined): string {
  return (hints?.explicit ?? env.AFK_PROVIDER ?? '').trim().toLowerCase();
}

function openaiSource(
  binding: ReturnType<typeof resolveBinding>,
  hints: ProviderRouteHints | undefined,
  opts: CredentialSourceOptions | undefined,
): string | undefined {
  const forceChatgpt = binding.provider === 'chatgpt-oauth';
  const endpoint = binding.baseUrl ?? (forceChatgpt ? undefined : hints?.openaiBaseUrl ?? env.AFK_OPENAI_BASE_URL);
  const override = endpointOverrideId(endpoint, 'openai');
  if (override !== undefined) return override;
  if (binding.apiKey === undefined && nonEmpty(opts?.configApiKey)) {
    // The session sends this key. If it IS the ambient tier's token (an
    // inherited parent key) name that tier; else it is the explicit-config tier.
    const ambient = resolveOpenAIAuth(undefined, {}, forceChatgpt);
    if (!forceChatgpt) return ambient.apiKey === opts.configApiKey ? `openai:${ambient.source}` : 'openai:config';
  }
  const auth = resolveOpenAIAuth(binding.apiKey, {}, forceChatgpt);
  return auth.apiKey !== null ? `openai:${auth.source}` : undefined;
}

function xaiSource(
  binding: ReturnType<typeof resolveBinding>,
  provider: string,
  hints: ProviderRouteHints | undefined,
  opts: CredentialSourceOptions | undefined,
): string | undefined {
  const slotOverride = endpointOverrideId(binding.baseUrl, 'xai');
  if (slotOverride !== undefined) return slotOverride;
  // Mirrors resolveXaiForceMode: slot force first, then explicit
  // `--provider xai` / AFK_PROVIDER=xai (API-key mode), else auto.
  const force = binding.provider === 'xai-oauth' || provider === 'xai-oauth'
    ? 'oauth'
    : binding.provider === 'xai' || explicitProviderRaw(hints) === 'xai' ? 'apikey' : undefined;
  let auth = resolveXaiAuth(binding.apiKey, force);
  if (binding.apiKey === undefined && nonEmpty(opts?.configApiKey) && auth.apiKey !== opts.configApiKey) {
    // An explicit key that is not the ambient tier's token: the provider sends
    // it as the config tier; a forced OAuth session ignores it.
    if (force === 'oauth') return auth.apiKey !== null ? xaiId(auth.source) : undefined;
    auth = resolveXaiAuth(opts.configApiKey, force);
  }
  if (auth.apiKey === null) return undefined;
  if (!nonEmpty(binding.baseUrl)) {
    const envUrl = auth.mode === 'oauth' ? env.AFK_XAI_OAUTH_BASE_URL : env.AFK_XAI_BASE_URL;
    const envOverride = endpointOverrideId(envUrl, 'xai');
    if (envOverride !== undefined) return envOverride;
  }
  return xaiId(auth.source);
}

function xaiId(source: string): string {
  return source === 'xai-oauth' ? 'xai:oauth' : `xai:${source}`;
}

function anthropicSource(
  binding: ReturnType<typeof resolveBinding>,
  opts: CredentialSourceOptions | undefined,
): string | undefined {
  const override = endpointOverrideId(binding.baseUrl ?? opts?.configBaseUrl ?? env.AFK_LOCAL_BASE_URL, 'anthropic');
  if (override !== undefined) return override;
  if (nonEmpty(binding.apiKey)) return 'anthropic:config';
  const cred: AnthropicCredential | undefined = opts?.noStoreRead === true
    ? resolveAnthropicCredentialFromEnv() ?? lastResolvedAnthropicCredential()
    : resolveAnthropicCredential();
  if (cred === undefined) return undefined;
  const key = opts?.configApiKey;
  if (!nonEmpty(key) || key === cred.token) return cred.source;
  // A different subscription token (the parent's bootstrap token after a
  // refresh) is still billed as a subscription; any other key has unknown
  // origin and records nothing.
  return key.startsWith('sk-ant-oat') && SUBSCRIPTION_TIERS.has(cred.source) ? cred.source : undefined;
}

/**
 * Resolve the credential source id for the provider serving `model`.
 * Mirrors the routing in `resolveCredentialForModel` + `applySlotCredentials`.
 */
export function credentialSourceForModel(
  model: string | undefined,
  hints?: ProviderRouteHints,
  opts?: CredentialSourceOptions,
): string | undefined {
  const binding = resolveBinding(model, hints?.slots);
  const provider = providerForModel(model, hints);
  if (provider === 'openai-compatible' || provider === 'openai-codex') return openaiSource(binding, hints, opts);
  if (provider === 'xai' || provider === 'xai-oauth') return xaiSource(binding, provider, hints, opts);
  return anthropicSource(binding, opts);
}

/**
 * Best-effort wrapper for observability call sites: never throws (trace
 * writers are fire-and-forget, INV-040).
 */
export function tryCredentialSourceForModel(
  model: string | undefined,
  hints?: ProviderRouteHints,
  opts?: CredentialSourceOptions,
): string | undefined {
  try {
    return credentialSourceForModel(model, hints, opts);
  } catch {
    return undefined;
  }
}
