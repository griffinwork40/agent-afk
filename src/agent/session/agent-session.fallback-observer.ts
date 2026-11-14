/**
 * Provider-event observer for the `model-fallback` notice.
 *
 * Extracted from {@link AgentSession} to keep agent-session.ts under the
 * 350-code-line ceiling. Called synchronously from `observeProviderEvent`
 * before the event is transformed.
 *
 * Contract: must not throw. Calls `applyFallbackModel` only when the event
 * is a notice with `kind === 'model-fallback'` and a non-empty `fallback.to`.
 * Plan-text observation is handled by the caller (PlanExitBridge).
 *
 * @module agent/session/agent-session.fallback-observer
 */

import type { ProviderEvent } from '../provider.js';
import { applyFallbackModel, type ConfigDeps } from './session-config.js';

/**
 * Observe a raw provider event and apply a fallback-model swap when present.
 * Safe to call with any event type — non-matching events are ignored.
 */
export function observeFallbackNotice(event: ProviderEvent, getConfigDeps: () => ConfigDeps): void {
  if (
    event.type === 'notice' &&
    event.kind === 'model-fallback' &&
    event.fallback?.to !== undefined
  ) {
    const deps = getConfigDeps();
    applyFallbackModel(event.fallback.to, deps);
    const modelFallback = { ...event.fallback, text: event.text };
    deps.getStateManager().setSessionMetadata((prev) => ({ ...prev, modelFallback }));
  }
}
