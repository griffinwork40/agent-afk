/**
 * Provider-routed one-shot completion: send ONE system+user prompt to ANY
 * configured model (slot name, custom slot name, identity alias, or raw id)
 * and return the reply text, without a live session for that model.
 *
 * Extracted from `compact-summarizer.ts` so cross-provider compaction and the
 * `model_complete` tool share one implementation of the per-provider auth
 * paths. Each path mirrors how a live session for that provider resolves
 * credentials:
 *   - anthropic → the Anthropic one-shot helper (oneShotCompletion).
 *   - openai (api-key mode) → Chat Completions via oneShotChatCompletion.
 *   - openai (chatgpt-oauth mode) → Responses wire via a purpose-built client
 *     constructed from the ChatGPT backend URL + auth headers, then oneShotResponses.
 *   - xai (api-key) → Chat Completions via oneShotChatCompletion + xAI endpoint.
 *   - xai (oauth) → Chat Completions via oneShotChatCompletion + xAI OAuth endpoint.
 *
 * Error text is built from a caller-supplied {@link OneShotLabel} so each
 * consumer keeps its own message prefix (compaction's messages are
 * byte-identical to the pre-extraction text).
 *
 * @module agent/providers/shared/one-shot-router
 */

import OpenAI from 'openai';
import { oneShotCompletionWithStop, type OneShotStopReason } from '../anthropic-direct/oneshot.js';
import {
  oneShotChatCompletionWithStop,
  oneShotResponses,
} from '../openai-compatible/oneshot.js';

export type { OneShotStopReason };
import { resolveOpenAIAuth } from '../openai-compatible/auth.js';
import {
  buildChatGptOAuthHeaders,
  CHATGPT_BACKEND_BASE_URL,
} from '../openai-compatible/responses-config.js';
import { resolveXaiAuth } from '../xai/auth.js';
import { resolveXaiEndpoint } from '../xai/endpoints.js';
import { ensureFreshAccessToken } from '../xai/oauth.js';
import { isAccessTokenExpired } from '../xai/query-helpers.js';
import { loadAnthropicCredential } from '../../auth/credential-resolver.js';
import { providerForModel } from '../index.js';
import { resolveBinding } from '../../session/model-slots.js';
import type { BundledProviderName } from '../index.js';

/** Per-slot credential fields a one-shot call honours. */
export interface OneShotBinding {
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
}

/** Message vocabulary for errors thrown by {@link routedOneShot}. */
export interface OneShotLabel {
  /** Bracketed prefix, e.g. `[afk/compact]`. */
  tag: string;
  /** What the call is for, e.g. `cross-provider compaction`. */
  purpose: string;
  /** Appended to the unsupported-provider error (how to pick a valid model). */
  unsupportedHint?: string;
}

/** A model input resolved to a concrete id, provider family, and binding. */
export interface OneShotTarget {
  model: string;
  provider: BundledProviderName;
  binding: OneShotBinding;
}

/** Inputs for {@link routedOneShot}. */
export interface RoutedOneShotInput extends OneShotTarget {
  system: string;
  user: string;
  maxTokens: number;
  label: OneShotLabel;
  signal?: AbortSignal;
}

/**
 * Resolve a raw model input (slot / custom name / alias / raw id) to the
 * concrete id, provider family, and per-slot credentials. Pure: never throws.
 * An unconfigured slot (empty id) falls back to the raw input as the id —
 * callers that must reject that case check `unconfiguredSlotError` first.
 */
export function resolveOneShotTarget(raw: string): OneShotTarget {
  const input = raw.trim();
  const binding = resolveBinding(input);
  const model = binding.id || input;
  const provider = providerForModel(model, {
    ...(binding.provider ? { explicit: binding.provider } : {}),
    ...(binding.baseUrl ? { openaiBaseUrl: binding.baseUrl } : {}),
  });
  return { model, provider, binding };
}

/**
 * Run one completion against `input.provider`, returning the reply text paired
 * with the mapped {@link OneShotStopReason}. Throws on missing credentials, an
 * unsupported provider, or any SDK error (including AbortError); there is no
 * fallback to another model.
 *
 * The Responses wire ({@link oneShotResponses}) already throws
 * `ResponsesSummaryIncompleteError` when the response is not fully complete, so
 * it never returns truncated text — the stop reason is always `'end'` on that
 * path.
 */
export async function routedOneShotWithStop(
  input: RoutedOneShotInput,
): Promise<{ text: string; stopReason: OneShotStopReason }> {
  const { provider } = input;
  if (provider === 'anthropic-direct' || provider === 'anthropic') {
    return viaAnthropic(input);
  }
  if (provider === 'openai-compatible' || provider === 'openai-codex') {
    return viaOpenAI(input);
  }
  if (provider === 'xai' || provider === 'xai-oauth') {
    return viaXai(input);
  }
  const hint = input.label.unsupportedHint ? ` ${input.label.unsupportedHint}` : '';
  throw new Error(`${input.label.tag} Unsupported cross-provider target: ${provider}.${hint}`);
}

/**
 * Thin wrapper around {@link routedOneShotWithStop} that discards the stop
 * reason and returns only the reply text — preserving the original surface for
 * the direct callers (e.g. compact-summarizer) that do not need stop-reason
 * visibility.
 */
export async function routedOneShot(input: RoutedOneShotInput): Promise<string> {
  const { text } = await routedOneShotWithStop(input);
  return text;
}

/** True when `url` routes to Anthropic's own API host. */
function isAnthropicApiHost(url: string): boolean {
  try {
    // Normalize a trailing-dot FQDN (e.g. 'api.anthropic.com.') — Node's URL
    // parser keeps the dot in `hostname`, so without this strip the canonical
    // host would be misidentified as a custom host and the ambient-credential
    // guard would throw erroneously.
    const { hostname } = new URL(url);
    return hostname.replace(/\.$/, '') === 'api.anthropic.com';
  } catch {
    return false;
  }
}

async function viaAnthropic(
  input: RoutedOneShotInput,
): Promise<{ text: string; stopReason: OneShotStopReason }> {
  const { binding, label } = input;
  // Security: when a custom baseUrl is set and it does NOT point to
  // api.anthropic.com, require an explicit binding.apiKey rather than falling
  // back to the ambient credential. Sending the ambient Anthropic key to a
  // user-configurable endpoint would allow a misconfigured (or malicious) URL
  // to exfiltrate the credential. An explicit apiKey in the binding opts in
  // knowingly; the ambient fallback is only safe for the canonical host.
  const hasCustomHost = !!binding.baseUrl && !isAnthropicApiHost(binding.baseUrl);
  let token: string | undefined;
  if (hasCustomHost) {
    token = binding.apiKey;
    if (!token) {
      throw new Error(
        `${label.tag} A custom Anthropic baseUrl (${binding.baseUrl}) was set but no ` +
        `explicit apiKey was provided. Set an explicit apiKey in the binding to prevent ` +
        `the ambient Anthropic credential from being sent to a non-Anthropic host.`,
      );
    }
  } else {
    token = binding.apiKey ?? loadAnthropicCredential();
    if (!token) {
      throw new Error(
        `${label.tag} No Anthropic credential for ${label.purpose}. ` +
        `Set ANTHROPIC_API_KEY or authenticate via Claude Code.`,
      );
    }
  }
  return oneShotCompletionWithStop({
    token,
    model: input.model,
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens,
    // Contract: forward baseUrl when the binding specifies a custom Anthropic
    // endpoint (e.g. a local Anthropic-compatible server). Without this the
    // API key is sent to the default api.anthropic.com instead of the intended
    // server.
    ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
    signal: input.signal,
  });
}

async function viaOpenAI(
  input: RoutedOneShotInput,
): Promise<{ text: string; stopReason: OneShotStopReason }> {
  const { binding, label } = input;
  // Resolve OpenAI auth from the binding's explicit key, or via the standard
  // chain (OPENAI_API_KEY → CODEX_API_KEY → ~/.codex/auth.json including
  // ChatGPT-subscription OAuth when AFK_OPENAI_CHATGPT_OAUTH is set).
  const auth = resolveOpenAIAuth(binding.apiKey, {}, binding.provider === 'chatgpt-oauth');
  if (auth.apiKey === null) {
    throw new Error(
      `${label.tag} No OpenAI credential for ${label.purpose} (source: ${auth.source}). ` +
      `Set OPENAI_API_KEY or authenticate via ChatGPT OAuth.`,
    );
  }

  // ChatGPT-subscription OAuth requires the Responses wire (the private
  // ChatGPT backend rejects Chat Completions requests). Build the client the
  // same way the session does — same base URL and account-id header — and
  // delegate to oneShotResponses with isChatGptBackend: true.
  // oneShotResponses throws when incomplete, so a successful return is always
  // 'end' — the Responses wire never exposes truncated text.
  if (auth.source === 'chatgpt-oauth') {
    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: CHATGPT_BACKEND_BASE_URL,
      defaultHeaders: buildChatGptOAuthHeaders(auth.accountId),
      // Contract: maxRetries: 0 — AFK owns retries via withTransientRetry.
      maxRetries: 0,
    });
    const text = await oneShotResponses({
      client,
      model: input.model,
      system: input.system,
      user: input.user,
      isChatGptBackend: true,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });
    return { text, stopReason: 'end' };
  }

  // Standard API-key path: Chat Completions.
  return oneShotChatCompletionWithStop({
    apiKey: auth.apiKey,
    baseURL: binding.baseUrl,
    model: input.model,
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens,
    signal: input.signal,
  });
}

async function viaXai(
  input: RoutedOneShotInput,
): Promise<{ text: string; stopReason: OneShotStopReason }> {
  const { binding, label } = input;
  // Resolve force mode:
  //   - binding.provider === 'xai-oauth' (explicit slot) → force oauth
  //   - provider === 'xai-oauth' (inferred from explicit slot-routed) → force oauth
  //   - binding.provider === 'xai' (explicit slot) → force apikey
  //   - otherwise (raw grok-* model, no explicit slot provider) → undefined
  //     (let resolveXaiAuth auto-detect, so SuperGrok OAuth-only sessions work)
  let forceMode: 'apikey' | 'oauth' | undefined;
  if (binding.provider === 'xai-oauth' || input.provider === 'xai-oauth') {
    forceMode = 'oauth';
  } else if (binding.provider === 'xai') {
    forceMode = 'apikey';
  }

  // Contract: for OAuth mode, run the standard refresh flow before resolving
  // credentials so an expiring token is refreshed proactively, mirroring
  // XaiProvider.complete() / XaiProvider.query().
  if (forceMode === 'oauth' || forceMode === undefined) {
    // ensureFreshAccessToken returns null when no tokens are stored; that is
    // handled below by resolveXaiAuth returning apiKey: null.
    await ensureFreshAccessToken({});
  }

  const resolution = resolveXaiAuth(binding.apiKey, forceMode);
  if (!resolution.apiKey || !resolution.mode) {
    throw new Error(
      `${label.tag} No xAI credential for ${label.purpose}. ` +
      `Set XAI_API_KEY or authenticate via SuperGrok OAuth.`,
    );
  }
  // Contract: mirror XaiProvider.complete(): never send an OAuth access token
  // that is still expired after the refresh attempt above.
  if (resolution.mode === 'oauth' && isAccessTokenExpired(resolution.expiresAt)) {
    throw new Error(
      `${label.tag} SuperGrok OAuth access token expired and refresh failed. ` +
      'Re-run `afk provider auth xai login`.',
    );
  }

  const endpoint = resolveXaiEndpoint(resolution.mode, {
    ...(binding.baseUrl ? { baseUrlOverride: binding.baseUrl } : {}),
  });

  return oneShotChatCompletionWithStop({
    apiKey: resolution.apiKey,
    baseURL: endpoint.baseURL,
    defaultHeaders: endpoint.defaultHeaders,
    model: input.model,
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens,
    signal: input.signal,
  });
}
