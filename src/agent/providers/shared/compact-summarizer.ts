/**
 * Cross-provider compact summarizer resolver.
 *
 * When `AFK_COMPACT_MODEL` names a model on the SAME provider family as the
 * current session, the session's own summarize closure is returned unchanged —
 * it already carries the right credentials, endpoint, and wire (responses vs.
 * chat-completions). When the model is on a DIFFERENT provider, this module
 * builds a foreign one-shot call and wraps it as a summarize closure.
 *
 * Supported foreign paths (implemented in `./one-shot-router.ts`, shared with
 * the `model_complete` tool):
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

import { redactSecrets } from '../../redact-secrets.js';
import { errorMessage } from '../../../utils/errors.js';
import {
  resolveOneShotTarget,
  routedOneShot,
  type OneShotBinding,
  type OneShotLabel,
} from './one-shot-router.js';
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
  const {
    model: targetModel,
    provider: targetProvider,
    binding,
  } = resolveOneShotTarget(compactModelRaw);

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

/** Error vocabulary for compaction's routed one-shot calls. */
const COMPACT_LABEL: OneShotLabel = {
  tag: '[afk/compact]',
  purpose: 'cross-provider compaction',
  unsupportedHint: 'Set AFK_COMPACT_MODEL to a model on anthropic, openai, or xai.',
};

/**
 * Build a cross-provider summarize closure for `targetModel` on `targetProvider`.
 * Warn dedup state is stored per-session via the WeakMap keyed by `sessionKey`.
 */
function buildForeignSummarize(
  targetModel: string,
  targetProvider: BundledProviderName,
  binding: OneShotBinding,
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
      return await routedOneShot({
        model: targetModel,
        provider: targetProvider,
        binding,
        system: COMPACT_SYSTEM_PROMPT,
        user: wrapTranscriptForSummary(transcript),
        maxTokens: COMPACT_MAX_TOKENS,
        label: COMPACT_LABEL,
        ...(signal ? { signal } : {}),
      });
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
        const rawMsg = errorMessage(err);
        // Redact before logging: provider SDK errors (e.g. OpenAI 401) can
        // echo partial API keys in the message body. Redact the full string
        // first so a secret straddling the 200-char boundary is never logged
        // unredacted, then truncate to 200 chars for display.
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
