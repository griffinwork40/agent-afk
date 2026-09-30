/**
 * Session-id resolution and presence-lifecycle wiring for one
 * `OpenAICompatibleProvider.query()` call.
 *
 * Extracted from `index.ts` (#2353 fix — mirrors dispatcher-wiring.ts for
 * anthropic-direct) so the concern lives in one place and the `query()` body
 * stays within the function-size ceiling.
 *
 * Invariant: `resolveSessionId` MUST be called before `buildRuntimeStateSource`
 * and before `buildDispatcher`, so both receive the same resolved id rather than
 * the resume-only `config.sessionId` that is absent on fresh telegram/daemon
 * sessions. Violation leaves `get_runtime_state` and the `# Environment` block
 * showing no id, and tool dispatchers (image_generate, workspace_*, state_*,
 * bash capture) losing attribution context.
 *
 * @module agent/providers/openai-compatible/session-wiring
 */

import type { AgentConfig } from '../../types/config-types.js';
import type { RuntimeStateSource } from '../../awareness/index.js';
import {
  resolveTopLevelSessionId,
  registerPresenceLifecycle,
  type SessionIdResolution,
} from '../shared/presence-lifecycle.js';

export interface ResolveSessionArgs {
  config: AgentConfig;
  surface: string;
  mintedSessionId: string | null;
}

export interface ResolveSessionResult {
  resolved: SessionIdResolution;
  /** Store this back into `this._mintedSessionId` after the call. */
  nextMintedSessionId: string | null;
}

/**
 * Resolve the per-query session id from config + provider memo.
 * Call BEFORE `buildRuntimeStateSource` so both the awareness source and the
 * dispatcher receive the same id.
 */
export function resolveSessionId(args: ResolveSessionArgs): ResolveSessionResult {
  const resolved = resolveTopLevelSessionId({
    sessionId: args.config.sessionId,
    resume: args.config.resume,
    depth: args.config.depth,
    parentSessionId: args.config.parentSessionId,
    surface: args.surface,
    memoized: args.mintedSessionId,
  });
  return { resolved, nextMintedSessionId: resolved.memoized };
}

export interface RegisterPresenceArgs {
  resolved: SessionIdResolution;
  config: AgentConfig;
  surface: string;
  runtimeStateSource: RuntimeStateSource;
  providerName: string;
  modelName: string;
  currentPresenceSessionId: string | null;
}

/**
 * Write a presence file when `resolved.shouldAdvertise` is true.
 * Returns the new `_presenceSessionId` to store on the provider instance.
 * Non-advertising surfaces (daemon/telegram fresh sessions) pass through
 * `currentPresenceSessionId` unchanged so no stale file is written.
 */
export function registerSessionPresence(args: RegisterPresenceArgs): string | null {
  if (!args.resolved.shouldAdvertise) return args.currentPresenceSessionId;
  return registerPresenceLifecycle({
    depth: args.config.depth,
    parentSessionId: args.config.parentSessionId,
    sessionId: args.resolved.id,
    currentPresenceSessionId: args.currentPresenceSessionId,
    runtimeStateSource: args.runtimeStateSource,
    surface: args.surface,
    cwd: args.config.cwd,
    providerName: args.providerName,
    model: args.modelName,
  });
}
