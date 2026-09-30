/**
 * Cross-provider compact summarizer resolver.
 *
 * When `AFK_COMPACT_MODEL` names a model on the SAME provider family as the
 * current session, the session's own summarize closure is returned unchanged —
 * it already carries the right credentials, endpoint, and wire (responses vs.
 * chat-completions). When the model is on a DIFFERENT provider, this module
 * builds a foreign one-shot call and wraps it as a summarize closure.
 *
 * Supported foreign paths:
 *   - anthropic → the Anthropic one-shot helper (oneShotCompletion).
 *   - openai (api-key mode) → Chat Completions via oneShotChatCompletion.
 *   - openai (chatgpt-oauth mode) → Responses wire via a purpose-built client
 *     constructed from the ChatGPT backend URL + auth headers, then oneShotResponses.
 *   - xai (api-key) → Chat Completions via oneShotChatCompletion + xAI endpoint.
 *   - xai (oauth) → Chat Completions via oneShotChatCompletion + xAI OAuth endpoint.
 *
 * Failure semantics (required by spec):
 *   - No silent fallback to the session model — on a non-abort cross-provider
 *     error the exception propagates and runCompactionCore records
 *     `summarization-failed: …`, leaving history untouched.
 *   - A one-time-per-SESSION warning is emitted when a foreign summarize first
 *     succeeds (privacy: the transcript is sent to a second vendor) and when the
 *     first cross-provider failure occurs. Two sessions in the same process each
 *     get their own independent warning state via a WeakMap keyed by sessionKey.
 *   - Aborts propagate as AbortErrors and are never swallowed.
 *
 * @module agent/providers/shared/compact-summarizer
 */

import OpenAI from 'openai';
import { oneShotCompletion } from '../anthropic-direct/oneshot.js';
import {
  oneShotChatCompletion,
  oneShotResponses,
} from '../openai-compatible/oneshot.js';
import { redactSecrets } from '../../redact-secrets.js';
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
import { COMPACT_SYSTEM_PROMPT, wrapTranscriptForSummary } from './compaction.js';
import type { BundledProviderName } from '../index.js';

// Contract: maxTokens for the summarize call. Matches the default in
// anthropic-direct/query/compact-handler.ts and openai-compatible/query.ts.
const COMPACT_MAX_TOKENS = 1024;

/** Summarize closure shape used by both compact-handler and openai-compatible query. */
export type SummarizeFn = (transcript: string, signal?: AbortSignal) => Promise<string>;

// Invariant: WeakMap keyed by a per-session opaque object, value is the warn
// state for that session. Each unique sessionKey object gets independent Sets,
// so session B never inherits session A's dedup history, while a single session
// that calls resolveCrossProviderSummarize on every compaction pass still only
// emits the privacy/failure warning once.
const warnedPrivacyBySession = new WeakMap<object, Set<string>>();
const warnedFailureBySession = new WeakMap<object, Set<string>>();

function getOrCreateSet(map: WeakMap<object, Set<string>>, key: object): Set<string> {
  let s = map.get(key);
  if (!s) {
    s = new Set<string>();
    map.set(key, s);
  }
  return s;
}

/**
 * Resolve the summarize function for a compaction pass.
 *
 * Contract:
 *   - When AFK_COMPACT_MODEL is unset, empty, or resolves to the same provider
 *     family as `sessionFamily`, returns `sessionSummarize` unchanged.
 *   - When the resolved model is on a foreign family, returns a wrapper that:
 *       1. Emits a one-time-per-session privacy warning (transcript crosses providers).
 *       2. Calls the appropriate one-shot helper.
 *       3. On a non-abort failure, emits a one-time-per-session failure warning
 *          and re-throws.
 *       4. On abort, re-throws unchanged.
 *   - `sessionKey` is an opaque object whose lifetime matches the session.
 *     Pass the provider instance (`this`), a stable per-session config object,
 *     or any other non-transient object that is created once per session and
 *     garbage-collected when the session ends. Two sessions must use distinct
 *     objects; the same session must reuse the same object across compaction
 *     passes.
 *
 * @param sessionFamily - The bundled provider name for the current session
 *   (e.g. `'anthropic-direct'`, `'openai-compatible'`, `'xai'`).
 * @param sessionSummarize - The session's own summarize closure (used for
 *   same-provider compaction and returned unchanged on no foreign target).
 * @param compactModelRaw - The raw AFK_COMPACT_MODEL value (may be a slot alias).
 *   Pass `undefined` to disable cross-provider logic (returns sessionSummarize).
 * @param sessionKey - Stable per-session identity object. Warn dedup state is
 *   stored in a WeakMap keyed by this object, so each session warns
 *   independently across compaction passes.
 */
export function resolveCrossProviderSummarize(
  sessionFamily: BundledProviderName,
  sessionSummarize: SummarizeFn,
  compactModelRaw: string | undefined,
  sessionKey: object,
): SummarizeFn {
  if (!compactModelRaw || compactModelRaw.trim().length === 0) {
    return sessionSummarize;
  }

  // Resolve slot aliases / custom names to the concrete binding so we can
  // inspect the provider family without instantiating a full AgentSession.
  const binding = resolveBinding(compactModelRaw.trim());
  const targetModel = binding.id || compactModelRaw.trim();
  const targetProvider = providerForModel(targetModel, {
    ...(binding.provider ? { explicit: binding.provider } : {}),
    ...(binding.baseUrl ? { openaiBaseUrl: binding.baseUrl } : {}),
  });

  // Normalize the session family so both `anthropic` and `anthropic-direct`
  // compare equal (providerForModel returns `'anthropic-direct'` but callers
  // may pass `'anthropic'`).
  const normalizedSession =
    sessionFamily === 'anthropic' ? 'anthropic-direct' :
    sessionFamily === 'openai-codex' ? 'openai-compatible' :
    sessionFamily === 'xai-oauth' ? 'xai' :
    sessionFamily;
  const normalizedTarget =
    targetProvider === 'anthropic' ? 'anthropic-direct' :
    targetProvider === 'openai-codex' ? 'openai-compatible' :
    targetProvider === 'xai-oauth' ? 'xai' :
    targetProvider;

  if (normalizedTarget === normalizedSession) {
    // Same family — let the session summarize (it has the right client, wire,
    // credentials). Do not rebuild auth or construct a foreign client.
    return sessionSummarize;
  }

  // Foreign family — build a cross-provider summarize closure.
  return buildForeignSummarize(targetModel, targetProvider, binding, sessionKey);
}

/** Inputs captured from the resolved binding for one foreign summarize closure. */
interface ForeignBinding {
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
}

/**
 * Build a cross-provider summarize closure for `targetModel` on `targetProvider`.
 * Warn dedup state is stored per-session via the WeakMap keyed by `sessionKey`.
 */
function buildForeignSummarize(
  targetModel: string,
  targetProvider: BundledProviderName,
  binding: ForeignBinding,
  sessionKey: object,
): SummarizeFn {
  return async (transcript: string, signal?: AbortSignal): Promise<string> => {
    // Privacy notice: one-time-per-session, before the request fires.
    const warnedPrivacy = getOrCreateSet(warnedPrivacyBySession, sessionKey);
    if (!warnedPrivacy.has(targetModel)) {
      warnedPrivacy.add(targetModel);
      // eslint-disable-next-line no-console
      console.warn(
        `[afk/compact] Cross-provider compaction: transcript will be sent to ` +
        `${targetProvider} (model: ${targetModel}). ` +
        `Ensure you consent to sharing conversation history with this provider.`,
      );
    }

    try {
      const system = COMPACT_SYSTEM_PROMPT;
      const user = wrapTranscriptForSummary(transcript);

      if (targetProvider === 'anthropic-direct' || targetProvider === 'anthropic') {
        return await summarizeViaAnthropic(targetModel, binding, system, user, signal);
      }
      if (targetProvider === 'openai-compatible' || targetProvider === 'openai-codex') {
        return await summarizeViaOpenAI(targetModel, binding, system, user, signal);
      }
      if (targetProvider === 'xai' || targetProvider === 'xai-oauth') {
        return await summarizeViaXai(targetModel, targetProvider, binding, system, user, signal);
      }
      // Unknown provider family: let it fall through as an error rather than
      // silently billing the session model.
      throw new Error(
        `[afk/compact] Unsupported cross-provider target: ${targetProvider}. ` +
        `Set AFK_COMPACT_MODEL to a model on anthropic, openai, or xai.`,
      );
    } catch (err) {
      // Aborts must propagate as-is so the compaction core records 'aborted'.
      // Contract: check signal.aborted first (most reliable), then accept any
      // object whose .name is 'AbortError' — DOMException may not be instanceof
      // Error in all environments.
      const isAbort =
        signal?.aborted === true ||
        (err != null && (err as { name?: unknown }).name === 'AbortError');
      if (isAbort) throw err;

      // One-time failure warning per session and target model id.
      const warnedFailure = getOrCreateSet(warnedFailureBySession, sessionKey);
      if (!warnedFailure.has(targetModel)) {
        warnedFailure.add(targetModel);
        const rawMsg = err instanceof Error ? err.message : String(err);
        // Redact before logging: provider SDK errors (e.g. OpenAI 401) can
        // echo partial API keys in the message body. Truncate to 200 chars so
        // a very long error body does not swamp stderr.
        const msg = redactSecrets(rawMsg).slice(0, 200);
        // eslint-disable-next-line no-console
        console.warn(
          `[afk/compact] Cross-provider summarization failed for ${targetProvider}/${targetModel}: ` +
          `${msg}. History unchanged. Check credentials for this provider.`,
        );
      }
      throw err;
    }
  };
}

// History: __resetCrossProviderWarnState was previously used by tests to clear
// module-scope Sets. The WeakMap approach makes per-session isolation automatic,
// so no reset is needed. The export is kept as a no-op so existing test imports
// don't break. See PR #2474.
export function __resetCrossProviderWarnState(): void {}

// ---------------------------------------------------------------------------
// Per-provider one-shot helpers
// ---------------------------------------------------------------------------

/** True when `url` routes to Anthropic's own API host. */
function isAnthropicApiHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

async function summarizeViaAnthropic(
  model: string,
  binding: ForeignBinding,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
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
        `[afk/compact] A custom Anthropic baseUrl (${binding.baseUrl}) was set but no ` +
        `explicit apiKey was provided. Set an explicit apiKey in the binding to prevent ` +
        `the ambient Anthropic credential from being sent to a non-Anthropic host.`,
      );
    }
  } else {
    token = binding.apiKey ?? loadAnthropicCredential();
    if (!token) {
      throw new Error(
        `[afk/compact] No Anthropic credential for cross-provider compaction. ` +
        `Set ANTHROPIC_API_KEY or authenticate via Claude Code.`,
      );
    }
  }
  return oneShotCompletion({
    token,
    model,
    system,
    user,
    maxTokens: COMPACT_MAX_TOKENS,
    // Contract: forward baseUrl when the binding specifies a custom Anthropic
    // endpoint (e.g. a local Anthropic-compatible server). Without this the
    // API key is sent to the default api.anthropic.com instead of the intended
    // server. Passed via the clientFactory hook so oneShotCompletion stays
    // additive (new field; ignored when undefined).
    ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
    signal,
  });
}

async function summarizeViaOpenAI(
  model: string,
  binding: ForeignBinding,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  // Resolve OpenAI auth from the binding's explicit key, or via the standard
  // chain (OPENAI_API_KEY → CODEX_API_KEY → ~/.codex/auth.json including
  // ChatGPT-subscription OAuth when AFK_OPENAI_CHATGPT_OAUTH is set).
  const auth = resolveOpenAIAuth(
    binding.apiKey,
    {},
    binding.provider === 'chatgpt-oauth',
  );

  if (auth.apiKey === null) {
    throw new Error(
      `[afk/compact] No OpenAI credential for cross-provider compaction (source: ${auth.source}). ` +
      `Set OPENAI_API_KEY or authenticate via ChatGPT OAuth.`,
    );
  }

  // ChatGPT-subscription OAuth requires the Responses wire (the private
  // ChatGPT backend rejects Chat Completions requests). Build the client the
  // same way the session does — same base URL and account-id header — and
  // delegate to oneShotResponses with isChatGptBackend: true.
  if (auth.source === 'chatgpt-oauth') {
    return summarizeViaChatGptOAuth(model, auth.apiKey, auth.accountId, system, user, signal);
  }

  // Standard API-key path: Chat Completions.
  return oneShotChatCompletion({
    apiKey: auth.apiKey,
    baseURL: binding.baseUrl,
    model,
    system,
    user,
    maxTokens: COMPACT_MAX_TOKENS,
    signal,
  });
}

/**
 * Summarize via the ChatGPT-subscription Responses wire.
 *
 * Contract: constructs the OpenAI client exactly as the session does
 * (CHATGPT_BACKEND_BASE_URL + buildChatGptOAuthHeaders) and delegates to
 * oneShotResponses with isChatGptBackend:true. This mirrors
 * OpenAICompatibleQuery.summarizeViaResponses without requiring a live session.
 */
async function summarizeViaChatGptOAuth(
  model: string,
  apiKey: string,
  accountId: string | undefined,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const headers = buildChatGptOAuthHeaders(accountId);
  const client = new OpenAI({
    apiKey,
    baseURL: CHATGPT_BACKEND_BASE_URL,
    defaultHeaders: headers,
  });
  return oneShotResponses({
    client,
    model,
    system,
    user,
    isChatGptBackend: true,
    maxTokens: COMPACT_MAX_TOKENS,
    signal,
  });
}

async function summarizeViaXai(
  model: string,
  targetProvider: BundledProviderName,
  binding: ForeignBinding,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  // Resolve force mode:
  //   - binding.provider === 'xai-oauth' (explicit slot) → force oauth
  //   - targetProvider === 'xai-oauth' (inferred from explicit slot-routed) → force oauth
  //   - binding.provider === 'xai' (explicit slot) → force apikey
  //   - otherwise (raw grok-* model, no explicit slot provider) → undefined
  //     (let resolveXaiAuth auto-detect, so SuperGrok OAuth-only sessions work)
  let forceMode: 'apikey' | 'oauth' | undefined;
  if (binding.provider === 'xai-oauth' || targetProvider === 'xai-oauth') {
    forceMode = 'oauth';
  } else if (binding.provider === 'xai') {
    forceMode = 'apikey';
  } else {
    forceMode = undefined;
  }

  // Contract: for OAuth mode, run the standard refresh flow before resolving
  // credentials so an expiring token is refreshed proactively, mirroring
  // XaiProvider.complete() / XaiProvider.query(). This prevents "expired token"
  // errors on compaction without requiring a full provider instantiation.
  if (forceMode === 'oauth' || forceMode === undefined) {
    // ensureFreshAccessToken returns null when no tokens are stored; that is
    // handled below by resolveXaiAuth returning apiKey: null.
    await ensureFreshAccessToken({});
  }

  const resolution = resolveXaiAuth(binding.apiKey, forceMode);
  if (!resolution.apiKey || !resolution.mode) {
    throw new Error(
      `[afk/compact] No xAI credential for cross-provider compaction. ` +
      `Set XAI_API_KEY or authenticate via SuperGrok OAuth.`,
    );
  }
  // Contract: mirror XaiProvider.complete(): never send an OAuth access token
  // that is still expired after the refresh attempt above.
  if (resolution.mode === 'oauth' && isAccessTokenExpired(resolution.expiresAt)) {
    throw new Error(
      '[afk/compact] SuperGrok OAuth access token expired and refresh failed. ' +
      'Re-run `afk provider auth xai login`.',
    );
  }

  const endpoint = resolveXaiEndpoint(resolution.mode, {
    ...(binding.baseUrl ? { baseUrlOverride: binding.baseUrl } : {}),
  });

  return oneShotChatCompletion({
    apiKey: resolution.apiKey,
    baseURL: endpoint.baseURL,
    defaultHeaders: endpoint.defaultHeaders,
    model,
    system,
    user,
    maxTokens: COMPACT_MAX_TOKENS,
    signal,
  });
}
