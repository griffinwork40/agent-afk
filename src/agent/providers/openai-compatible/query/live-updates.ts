/**
 * Live-session mutations for OpenAICompatibleQuery — methods that change
 * query state between turns without resetting the session.
 *
 * Mirrors `anthropic-direct/query-live-updates.ts` for the OpenAI-compatible
 * provider. Extracted into a sibling file so `query.ts` stays under the
 * 350-code-line ceiling.
 *
 * @module agent/providers/openai-compatible/query/live-updates
 */

import type { AgentConfig } from '../../../types/config-types.js';

/**
 * Swap the system prompt for all subsequent turns.
 *
 * The system message is baked into `opts.config.systemPrompt` and read by
 * `buildMessages()` on every iteration. We mutate the config object in place
 * (same object reference `query.ts` holds as `this.opts.config`) so the next
 * turn's `buildMessages` call picks it up without any further plumbing —
 * identical to how `rebuildEnvironmentBlock` works in `index.ts` (#876).
 *
 * When `systemPromptRebuildFactory` is absent the caller is operating without
 * the provider-level fragment assembler (e.g. direct test construction). In
 * that case we still mutate `config.systemPrompt` directly with `basePrompt`
 * so the method remains useful. Returns `true` when the factory is present
 * (matching the anthropic-direct contract: factory = full rebuild).
 */
export function applySetSystemPrompt(
  config: AgentConfig,
  basePrompt: string | undefined,
  systemPromptRebuildFactory?: (basePrompt: string | undefined) => string,
): boolean {
  if (systemPromptRebuildFactory) {
    config.systemPrompt = systemPromptRebuildFactory(basePrompt);
    return true;
  }
  // Direct path: no fragment assembler — swap the raw value.
  config.systemPrompt = basePrompt;
  return false;
}

/**
 * Wire a steering callback for inter-round message injection.
 *
 * The callback is stored on the query and read by `runTurnInner` after each
 * tool round. The output (if non-empty) is appended to the last tool-result
 * user message before the next model call — same mechanism as the
 * anthropic-direct `applyBeforeNextRound` (loop/inter-round.ts).
 *
 * We store the live callback reference; the driver reads it via the context
 * interface on every round boundary, so clearing with `undefined` takes effect
 * on the very next round.
 */
export type BeforeNextRoundCallback = (() => string | undefined) | undefined;
