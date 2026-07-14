/**
 * Read-only, synchronous "is this model likely usable right now?" predicate.
 *
 * Purely advisory: used to ANNOTATE model picker labels (Telegram `/model`,
 * CLI `/model` list) with a hint when a tier's credential is missing —
 * NEVER to filter, reorder, or block selection of any handle. Deliberately
 * conservative: any uncertainty (unknown provider shape, unexpected error)
 * resolves to `available: true` so a working model is never hidden behind a
 * false negative. Never throws; never reads `process.env` directly (routes
 * through the existing credential resolvers, which use the typed `env`).
 *
 * @module agent/auth/model-availability
 */

import { providerForModel } from '../providers/index.js';
import { resolveBinding, type ModelSlotBinding, type ModelSlots } from '../session/model-slots.js';
import { loadAnthropicCredential, loadOpenAICredential } from './credential-resolver.js';
import { resolveOpenAIAuth } from '../providers/openai-compatible/auth.js';

/** What kind of credential a model would need, for the hint message. */
export type AvailabilityNeed = 'anthropic' | 'openai' | 'chatgpt-oauth' | 'local' | 'unknown';

/** Result of an availability check. */
export interface ModelAvailability {
  /** Conservative "probably usable" verdict — true unless a credential is confirmed missing. */
  available: boolean;
  /** What credential family this model would draw on. */
  needs: AvailabilityNeed;
  /** Short human-readable reason, present only when `available` is false. */
  hint?: string;
}

/**
 * Determine whether `model` is likely usable given currently-resolvable
 * credentials. Conservative: any error or unrecognized shape resolves to
 * `{ available: true, needs: 'unknown' }` rather than a false negative.
 */
export function modelAvailability(model: string | undefined, bindings?: ModelSlots): ModelAvailability {
  try {
    if (!model || model.trim().toLowerCase() === 'auto') return { available: true, needs: 'unknown' };
    const b: ModelSlotBinding = resolveBinding(model, bindings);
    // Empty id (the default `local` slot) means the tier is simply unconfigured.
    if (b.id === '') {
      return { available: false, needs: 'local', hint: 'not configured (set AFK_MODEL_LOCAL / models.local)' };
    }
    // A `chatgpt-oauth` slot forces the ChatGPT-subscription OAuth path at
    // runtime: applySlotCredentials sets `forceChatgptOAuth`, and
    // resolveOpenAIAuth(..., true) resolves from ~/.codex/auth.json REGARDLESS
    // of any per-slot/explicit apiKey. So this must precede the generic apiKey
    // short-circuit below — otherwise a slot carrying a stale per-slot key but
    // no OAuth token is mislabeled available (no sign-in hint) while the next
    // real request fails for missing ChatGPT sign-in.
    if (b.provider === 'chatgpt-oauth') {
      const ok = resolveOpenAIAuth(undefined, {}, true).apiKey != null;
      return { available: ok, needs: 'chatgpt-oauth', hint: ok ? undefined : 'needs ChatGPT sign-in (~/.codex/auth.json)' };
    }
    if (b.apiKey) return { available: true, needs: 'unknown' };
    // Thread the supplied `bindings` through so provider routing resolves the
    // SAME table `resolveBinding` used above (mirrors applySlotCredentials);
    // otherwise an explicit bindings arg diverging from the process-global
    // singleton would be checked against the wrong credential family.
    const provider = providerForModel(model, bindings ? { slots: bindings } : undefined);
    if (provider === 'anthropic-direct') {
      const ok = !!loadAnthropicCredential();
      return { available: ok, needs: 'anthropic', hint: ok ? undefined : 'needs Claude sign-in / ANTHROPIC_API_KEY' };
    }
    if (provider === 'openai-compatible') {
      // Custom endpoint: key requirement is unknowable from here — conservative.
      if (b.baseUrl) return { available: true, needs: 'local' };
      const ok = !!loadOpenAICredential() || resolveOpenAIAuth(undefined, {}, false).apiKey != null;
      return { available: ok, needs: 'openai', hint: ok ? undefined : 'needs OPENAI_API_KEY' };
    }
    return { available: true, needs: 'unknown' };
  } catch {
    return { available: true, needs: 'unknown' };
  }
}

/** Convenience boolean form of {@link modelAvailability}. */
export function isModelAvailable(model: string | undefined, bindings?: ModelSlots): boolean {
  return modelAvailability(model, bindings).available;
}
