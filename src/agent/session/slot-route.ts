/**
 * The provider family a slot's explicit `provider` field selects for its
 * per-slot credentials and `baseUrl`.
 *
 * Contract: returns `undefined` when the slot has no explicit provider; callers
 * then fall back to the id-inferred route (`providerForModel`). This is the
 * slot-provider-first precedence `applySlotCredentials` uses to decide which
 * config field receives the slot's `baseUrl` (`baseUrl` / `openaiBaseUrl` /
 * `xaiBaseUrl`). It can differ from the wire route `providerForModel` picks,
 * because a global `AFK_PROVIDER` (tier 1) beats the slot's own provider there.
 *
 * Dependency-free on purpose: `afk doctor` imports it without pulling in the
 * provider registry, and `slot-credentials.ts` uses it so the two never drift.
 *
 * @module agent/session/slot-route
 */

import type { SlotProvider } from './model-slots.js';

export type SlotEndpointRoute = 'anthropic-direct' | 'openai-compatible' | 'xai';

export function explicitSlotRoute(provider: SlotProvider | undefined): SlotEndpointRoute | undefined {
  if (provider === 'anthropic') return 'anthropic-direct';
  if (provider === 'openai' || provider === 'chatgpt-oauth') return 'openai-compatible';
  if (provider === 'xai' || provider === 'xai-oauth') return 'xai';
  return undefined;
}
