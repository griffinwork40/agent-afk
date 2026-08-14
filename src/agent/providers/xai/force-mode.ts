/**
 * Resolve the effective xAI auth force mode from construction + config flags.
 *
 * @module agent/providers/xai/force-mode
 */

import type { XaiAuthForceMode } from './auth.js';

/**
 * @param constructionMode - set when the provider was built for `--provider xai`
 *   (`apikey`) or `xai-oauth` (`oauth`); undefined for auto-routed Grok models.
 * @param forceXaiOAuth - slot / config flag from `applySlotCredentials`.
 * @param forceXaiApiKey - slot / config flag for `provider: 'xai'` (API-key force).
 */
export function resolveXaiForceMode(
  constructionMode: XaiAuthForceMode,
  forceXaiOAuth: boolean | undefined,
  forceXaiApiKey?: boolean | undefined,
): XaiAuthForceMode {
  // OAuth force wins over apikey force if both somehow set (shouldn't happen).
  if (forceXaiOAuth === true) return 'oauth';
  if (forceXaiApiKey === true) return 'apikey';
  // Explicit construction for `--provider xai` / AFK_PROVIDER=xai forces apikey
  // even when OAuth tokens exist (matches locked "explicit mode" decision).
  if (constructionMode === 'apikey' || constructionMode === 'oauth') return constructionMode;
  return undefined;
}

/**
 * Force mode for `complete()` (ghost-text / oneshot), which has no AgentConfig.
 *
 * Contract: after a successful `query()` resolution, reuse that mode so slot
 * `forceXaiOAuth` / `forceXaiApiKey` still apply on the side channel. Before
 * any query, fall back to construction-time force only.
 */
export function resolveCompleteForceMode(
  constructionMode: XaiAuthForceMode,
  lastResolvedMode: 'apikey' | 'oauth' | undefined,
): XaiAuthForceMode {
  if (lastResolvedMode !== undefined) return lastResolvedMode;
  return resolveXaiForceMode(constructionMode, undefined, undefined);
}

/**
 * Construction-time authMode for `XaiProvider` from the routed family name and
 * whether the user/env explicitly passed `--provider` / `AFK_PROVIDER`.
 *
 * Contract:
 *   - `xai-oauth` (explicit or slot-routed) → always force OAuth
 *   - explicit `xai` → force API-key mode
 *   - auto-routed `xai` (model heuristic only) → undefined (resolveXaiAuth auto)
 *
 * Without this split, auto-routing `grok-*` through parseProvider forced
 * apikey mode and broke SuperGrok OAuth-only sessions.
 */
export function resolveXaiConstructionAuthMode(
  effective: 'xai' | 'xai-oauth',
  wasExplicitProvider: boolean,
): XaiAuthForceMode {
  if (effective === 'xai-oauth') return 'oauth';
  if (wasExplicitProvider) return 'apikey';
  return undefined;
}
