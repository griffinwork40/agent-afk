/**
 * Per-slot provider credential application (model slots, Stage 2).
 *
 * A session runs exactly one model. When that model resolves to a slot carrying
 * per-slot `provider`/`baseUrl`/`apiKey`, route those onto the session config so
 * the active provider picks them up at query time:
 *   - apiKey   → `config.apiKey` (read by both providers at query time).
 *   - baseUrl  → `config.baseUrl` (Anthropic) or `config.openaiBaseUrl` (OpenAI),
 *     chosen by the resolved provider family.
 *
 * Lives in its own module (not `model-slots.ts`) because the provider-family
 * inference needs `providerForModel`, and `providers/index.ts` already imports
 * `model-slots.ts` — importing it back there would create a cycle. Nothing
 * imports this module except `agent-session.ts`, so no cycle here.
 *
 * Invariant (#548): for a configured slot the slot's key is *authoritative*.
 * Either the per-slot key is applied, or — for an OpenAI tier or any custom
 * `baseUrl` shim with no per-slot key — `config.apiKey` is CLEARED so the
 * provider falls back to its own env source (`OPENAI_API_KEY` / `~/.codex`, or
 * `AFK_LOCAL_API_KEY`). This matters because the `loadConfig` #548 gate runs
 * *before* slot bindings are installed, so a file-bound non-Anthropic tier can
 * momentarily carry the global Anthropic credential in `config.apiKey`; clearing
 * here — at the point of use, before the provider reads it — guarantees an
 * Anthropic key never reaches an OpenAI tier or a custom-endpoint shim. An
 * Anthropic *cloud* tier with no per-slot key keeps the resolved credential.
 *
 * @module agent/session/slot-credentials
 */

import { providerForModel } from '../providers/index.js';
import { getSlotBindings, slotForInput, type ModelSlots } from './model-slots.js';

/** The session-config fields {@link applySlotCredentials} may mutate. */
export interface SlotCredentialTarget {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  openaiBaseUrl?: string;
  /** Set true for a `provider: 'chatgpt-oauth'` slot — forces ChatGPT OAuth. */
  forceChatgptOAuth?: boolean;
  /** Set true for a `provider: 'xai-oauth'` slot — forces SuperGrok OAuth. */
  forceXaiOAuth?: boolean;
  /** Set true for a `provider: 'xai'` slot — forces metered API-key mode. */
  forceXaiApiKey?: boolean;
  /** Per-slot xAI endpoint only (never global AFK_OPENAI_BASE_URL). */
  xaiBaseUrl?: string;
}

/**
 * Apply the resolved model's per-slot credentials onto `config` in place.
 *
 * Near-no-op when `config.model` is not a configured slot (a raw id or `auto`):
 * only clears any inherited `forceChatgptOAuth` so it cannot leak across a
 * `/model` switch; those tiers are otherwise gated correctly upstream without
 * bindings. For a configured slot:
 *   - apiKey: the per-slot key when present; otherwise CLEARED for an OpenAI
 *     tier or a custom-`baseUrl` shim (so a global Anthropic credential can't
 *     leak onto it — see the #548 invariant in the module doc). An Anthropic
 *     cloud tier with no per-slot key keeps the resolved credential.
 *   - baseUrl: routed to `config.baseUrl` (Anthropic) or `config.openaiBaseUrl`
 *     (OpenAI) per the resolved provider.
 *
 * @param config   Session config to mutate (`model` is the input alias/id).
 * @param bindings Optional explicit bindings (tests); defaults to the installed
 *                 process-global table.
 */
export function applySlotCredentials(config: SlotCredentialTarget, bindings?: ModelSlots): void {
  const table = bindings ?? getSlotBindings();
  const slot = slotForInput(config.model, table);
  if (!slot) {
    // Not a configured slot (raw id / `auto`): no per-slot force. Clear any
    // inherited forced-OAuth so a raw id switched to from a chatgpt-oauth /
    // xai-oauth startup slot doesn't keep forcing those tokens — `resolveInner`
    // spreads a shared baseConfig for every /model target (#548).
    config.forceChatgptOAuth = false;
    config.forceXaiOAuth = false;
    config.forceXaiApiKey = false;
    config.xaiBaseUrl = undefined;
    return;
  }
  const binding = table[slot];

  const route =
    binding.provider === 'anthropic'
      ? 'anthropic-direct'
      : binding.provider === 'openai' || binding.provider === 'chatgpt-oauth'
        ? 'openai-compatible'
        : binding.provider === 'xai' || binding.provider === 'xai-oauth'
          ? 'xai'
          : providerForModel(config.model, bindings ? { slots: bindings } : undefined);

  // A slot bound `provider: 'chatgpt-oauth'` selects the ChatGPT-subscription
  // token for THIS tier regardless of OPENAI_API_KEY / the global
  // AFK_OPENAI_CHATGPT_OAUTH flag — see resolveOpenAIAuth(..., forceChatgptOAuth).
  // Written unconditionally (set AND clear): `resolveInner` spreads a shared
  // baseConfig for every /model target, so a stale `forceChatgptOAuth: true`
  // from the startup slot must be cleared when switching to a non-chatgpt slot,
  // else resolveOpenAIAuth keeps forcing the ChatGPT token and ignores the
  // tier/env key. The apiKey is still cleared below (route === 'openai-compatible').
  config.forceChatgptOAuth = binding.provider === 'chatgpt-oauth';
  // SuperGrok OAuth vs metered API-key force — mutual exclusive per slot.
  config.forceXaiOAuth = binding.provider === 'xai-oauth';
  config.forceXaiApiKey = binding.provider === 'xai';

  // Contract (#555 nit): a `provider: 'chatgpt-oauth'` slot that also carries an
  // explicit `apiKey` will have `config.apiKey` set below, but `resolveOpenAIAuth`
  // Tier 0 short-circuits on `forceChatgptOAuth` before it ever reaches the
  // explicit-key tier — so the key is effectively ignored and OAuth wins.
  // Behavior is intentional and safe (the slot declared OAuth). A config-load
  // warning when both are present is the right UX fix, but this module has no
  // warning channel today. The redundant assignment is left in place so the
  // clear-branch below does not need a `chatgpt-oauth` carve-out.
  if (binding.apiKey !== undefined) {
    config.apiKey = binding.apiKey;
  } else if (
    route === 'openai-compatible' ||
    route === 'xai' ||
    binding.baseUrl !== undefined
  ) {
    // Authoritative clear: a slot with no per-slot key must not inherit a
    // credential loaded for the default/global model (the #548 gate runs before
    // bindings are installed). Cleared → the provider uses its own env source.
    config.apiKey = undefined;
  }
  // else: Anthropic cloud tier, no per-slot key — keep the resolved credential.

  if (binding.baseUrl !== undefined) {
    if (route === 'xai') {
      // xAI slot baseUrl only — never via openaiBaseUrl (global AFK_OPENAI_BASE_URL).
      config.xaiBaseUrl = binding.baseUrl;
    } else if (route === 'openai-compatible') {
      config.openaiBaseUrl = binding.baseUrl;
    } else {
      config.baseUrl = binding.baseUrl;
    }
  } else if (route === 'xai') {
    // Clear stale slot override when switching to an xAI tier without baseUrl.
    config.xaiBaseUrl = undefined;
  }
}
