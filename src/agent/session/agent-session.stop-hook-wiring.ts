/**
 * Provider-side stop-hook seam wiring for AgentSession (issue #2714).
 *
 * Extracted from agent-session.ts so the file stays under the 350-code-line
 * ceiling. Owns two exported functions:
 *
 *   - `buildBeforeTurnEnd` – builds the `beforeTurnEnd` callback that
 *     `AgentSession.wireStopHook` installs on the provider query, enabling
 *     blocking Stop hooks to trigger same-turn continuations at the provider
 *     layer, before `turn.completed` is emitted.
 *
 *   - `applyStopHookWiring` – the full `wireStopHook` body, relocated here
 *     so agent-session.ts remains under the 350-code-line ceiling. Stores
 *     the new `StopWiring` reference and re-wires the provider-side seam.
 *
 * @module agent/session/agent-session.stop-hook-wiring
 */

import { runBeforeTurnEnd } from '../providers/shared/stop-hook-continuation.js';
import type { ProviderQuery } from '../provider.js';
import type { AgentConfig } from '../types.js';
import type { StopWiring } from '../types/session-types.js';
import type { Message } from '../types.js';
import type { ToolEventMin } from '../done-evidence.js';

/**
 * Minimal slice of AgentSession that the seam callback needs to close over.
 * Using an interface instead of the class reference prevents a circular-import
 * cycle and makes the dependency surface explicit.
 */
export interface StopHookWiringDeps {
  readonly getConfig: () => AgentConfig;
  readonly getSessionId: () => string | undefined;
  readonly getSignal: () => AbortSignal;
  readonly getConversationHistory: () => readonly Message[];
  readonly getActiveTurnToolEvents: () => readonly ToolEventMin[];
  readonly getStopWiring: () => StopWiring | undefined;
}



/**
 * Build the `beforeTurnEnd` callback for the provider-side stop-hook seam.
 *
 * The returned function is closed over `deps` so all reads happen at call time
 * (lazy reads) — `getConfig()` sees the post-`/clear` config, and
 * `getStopWiring()` sees whatever the surface last wired.
 *
 * @param deps  Live-read accessors from the owning `AgentSession`.
 * @returns     A callback suitable for `ProviderQuery.setBeforeTurnEnd()`.
 */
export function buildBeforeTurnEnd(
  deps: StopHookWiringDeps,
): (continuation: number, assistantText?: string) => Promise<{ continueWith?: string } | undefined> {
  return async (continuation: number, assistantText?: string): Promise<{ continueWith?: string } | undefined> => {
    const cfg = deps.getConfig();
    const sessionId = deps.getSessionId() ?? '';
    const signal = deps.getSignal();
    const messages = deps.getConversationHistory();
    const toolEvents = deps.getActiveTurnToolEvents();
    const currentWiring = deps.getStopWiring();
    const result = await runBeforeTurnEnd({
      config: cfg,
      sessionId,
      signal,
      messages,
      // Finding 3: thread the provider's just-finished assistant text directly
      // into the seam context so buildStopContext sees fresh data.
      ...(assistantText !== undefined ? { assistantText } : {}),
      toolEvents,
      surface: typeof cfg.surface === 'string' ? cfg.surface : undefined,
      hasNextTurn: currentWiring?.getHasNextTurn() ?? false,
      wiring: currentWiring !== undefined ? {
        onStopInjectContext: currentWiring.onStopInjectContext,
        onStopBlocked: currentWiring.onStopBlocked,
        onStopTimeout: currentWiring.onStopTimeout,
      } : undefined,
      continuation,
    });
    // Finding 2: signal that the provider seam dispatched Stop this turn,
    // so turn-stream-runner.ts skips the duplicate dispatchTurnStop. Set ONLY
    // when the seam really dispatched (#2957): with a cap of 0 (or no
    // registry) the seam returns early, and the session-layer fallback must
    // still fire Stop. Never reset here — a later cap-reached round in the
    // same turn must not clear a dispatch from an earlier round.
    if (currentWiring && result.dispatched === true) currentWiring.stopDispatchedBySeam = true;
    return result;
  };
}

/**
 * Wire the provider-side `beforeTurnEnd` seam for a newly installed `StopWiring`.
 * Called from `AgentSession.wireStopHook` — body moved here so `agent-session.ts`
 * stays under the 350-code-line ceiling.
 *
 * The caller must have already stored `wiring`; `getStopWiring` is a lazy reader
 * so that `buildBeforeTurnEnd` always sees the surface's live wiring at call time.
 *
 * @param wiring          The `StopWiring` just installed on the session.
 * @param getConfig       Live reader — sees the post-`/clear` config.
 * @param getSessionId    Live reader — returns the current provider session id.
 * @param getSignal       Live reader — returns the session's abort signal.
 * @param getMessages     Live reader — returns the current conversation history.
 * @param getToolEvents   Live reader — returns the active-turn tool events.
 * @param providerQuery   The active `ProviderQuery`; `setBeforeTurnEnd` is optional.
 */
export function applyStopHookWiring(
  wiring: StopWiring,
  getConfig: () => AgentConfig,
  getSessionId: () => string | undefined,
  getSignal: () => AbortSignal,
  getMessages: () => readonly Message[],
  getToolEvents: () => readonly ToolEventMin[],
  providerQuery: ProviderQuery,
): void {
  const deps: StopHookWiringDeps = {
    getConfig,
    getSessionId,
    getSignal,
    getConversationHistory: getMessages,
    getActiveTurnToolEvents: getToolEvents,
    getStopWiring: () => wiring,
  };
  providerQuery.setBeforeTurnEnd?.(buildBeforeTurnEnd(deps));
}
