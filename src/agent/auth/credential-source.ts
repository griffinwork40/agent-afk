/**
 * Provider-aware credential PROVENANCE for a model (#4882).
 *
 * Companion to {@link resolveCredentialForModel}: same routing decision
 * (`providerForModel` + the slot binding), but returns only a stable source id
 * — never token material — so receipts, traces and sidecars can split spend by
 * the credential that actually paid for it.
 *
 * Contract (ids, by provider family):
 *   - anthropic-direct: the Anthropic tier from `resolveAnthropicCredential()`
 *     (`ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | `claude-code-keychain`
 *     | `claude-code-session-refresh`).
 *   - openai-compatible: `resolveOpenAIAuth().source` (`config` | `env` |
 *     `codex-cli` | `chatgpt-oauth`).
 *   - xai / xai-oauth: `xai-config` | `xai-env` | `xai-oauth`.
 *   - A slot carrying its own `apiKey`: `slot-config`.
 *   - A keyless self-hosted endpoint (slot `baseUrl` with no key, or an
 *     Anthropic-routed model under `AFK_LOCAL_BASE_URL`): `local`.
 *
 * Invariant: a model that does not route to `anthropic-direct` NEVER yields an
 * Anthropic tier. Returns `undefined` when no usable credential resolves —
 * callers record the field as absent rather than guessing.
 *
 * @module agent/auth/credential-source
 */

import { providerForModel, type ProviderRouteHints } from '../providers/index.js';
import { resolveOpenAIAuth } from '../providers/openai-compatible/auth.js';
import { resolveXaiAuth } from '../providers/xai/auth.js';
import { resolveBinding } from '../session/model-slots.js';
import { resolveAnthropicCredential } from './credential-resolver.js';
import { env } from '../../config/env.js';

/** Fixed id for keyless / self-hosted endpoints. */
export const LOCAL_CREDENTIAL_SOURCE = 'local';
/** Fixed id for a credential supplied by the model slot's own `apiKey`. */
export const SLOT_CREDENTIAL_SOURCE = 'slot-config';

/**
 * Resolve the credential source id that would serve `model`. Pure lookup of
 * provenance; never returns, logs, or persists a token.
 */
export function resolveCredentialSourceForModel(
  model: string | undefined,
  hints?: ProviderRouteHints,
): string | undefined {
  const provider = providerForModel(model, hints);
  const binding = resolveBinding(model, hints?.slots);
  const hasSlotKey = binding.apiKey !== undefined && binding.apiKey.length > 0;
  const hasSlotBaseUrl = binding.baseUrl !== undefined && binding.baseUrl.trim().length > 0;

  if (provider === 'openai-compatible') {
    if (hasSlotKey && binding.provider !== 'chatgpt-oauth') return SLOT_CREDENTIAL_SOURCE;
    if (hasSlotBaseUrl && binding.provider !== 'chatgpt-oauth') return LOCAL_CREDENTIAL_SOURCE;
    const auth = resolveOpenAIAuth(undefined, {}, binding.provider === 'chatgpt-oauth');
    return auth.apiKey !== null ? auth.source : undefined;
  }

  if (provider === 'xai' || provider === 'xai-oauth') {
    if (hasSlotKey && binding.provider !== 'xai-oauth') return SLOT_CREDENTIAL_SOURCE;
    const force = provider === 'xai-oauth' || binding.provider === 'xai-oauth'
      ? 'oauth'
      : binding.provider === 'xai' ? 'apikey' : undefined;
    const auth = resolveXaiAuth(undefined, force);
    if (auth.apiKey === null) return undefined;
    return auth.source === 'xai-oauth' ? 'xai-oauth' : `xai-${auth.source}`;
  }

  // anthropic-direct
  if (hasSlotKey) return SLOT_CREDENTIAL_SOURCE;
  if (hasSlotBaseUrl) return LOCAL_CREDENTIAL_SOURCE;
  // Local-server mode: `AFK_LOCAL_BASE_URL` points every Anthropic-routed
  // session (and its children, via parentBaseUrl) at a self-hosted shim with a
  // placeholder key — real Anthropic credentials are never sent there.
  const localBaseUrl = env.AFK_LOCAL_BASE_URL;
  if (localBaseUrl && localBaseUrl.length > 0) return LOCAL_CREDENTIAL_SOURCE;
  return resolveAnthropicCredential()?.source;
}
