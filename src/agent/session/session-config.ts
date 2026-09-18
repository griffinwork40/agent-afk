/**
 * Config-mutation methods, extracted from {@link AgentSession}.
 *
 * Owns five public mutators that change live session configuration
 * without starting a new provider turn, plus the plan-exit seed drainer:
 *   - `setModel()` — swap the active model
 *   - `setPermissionMode()` — flip plan/default mode
 *   - `setSystemPrompt()` — override the base system prompt
 *   - `setCwd()` — update the working directory
 *   - `reauth()` — trigger a provider credential refresh
 *   - `takePendingPlanExitSeed()` — atomically drain and apply a queued plan-exit
 *
 * Also exports the {@link ConfigDeps} interface that threads dependencies into
 * each function without a back-reference to {@link AgentSession}.
 *
 * @module agent/session/session-config
 */

import { debugLog } from '../../utils/debug.js';
import type { AgentModelInput, OutputEvent, PermissionMode } from '../types.js';
import type { AgentConfig } from '../types.js';
import type { ProviderQuery } from '../provider.js';
import type { SessionStateManager } from './session-state.js';
import type { PlanExitBridge } from './plan-exit-bridge.js';
import { resolveModelId } from './model-resolution.js';
import { updatePresenceCwd } from '../awareness/presence.js';

/** Context bag threaded into the config-mutation functions. */
export interface ConfigDeps {
  getConfig: () => AgentConfig;
  setConfig: (patch: (prev: AgentConfig) => AgentConfig) => void;
  getProviderQuery: () => ProviderQuery;
  getStateManager: () => SessionStateManager;
  getPlanExit: () => PlanExitBridge;
  pushSidebandEvent: (event: OutputEvent) => void;
}

/**
 * Swap the active model. Forwards the *requested* model (alias or full id) to
 * the provider, not the resolved wire id: alias resolution is lossy for
 * context-window purposes (opus_1m and opus share a wire id but differ in
 * window), so the provider needs the alias to look up the right limit.
 */
export async function setModel(model: AgentModelInput | undefined, deps: ConfigDeps): Promise<void> {
  const resolved = resolveModelId(model);
  if (typeof model === 'string' && model.length > 0) await deps.getProviderQuery().setModel(model);
  if (resolved) deps.getStateManager().setSessionMetadata((prev) => ({ ...prev, model: resolved }));
}

/** Flip plan vs. default permission mode, updating provider + state + sideband. */
export async function setPermissionMode(mode: PermissionMode, deps: ConfigDeps): Promise<void> {
  const current = deps.getStateManager().getSessionMetadata().permissionMode;
  deps.getPlanExit().recordModeTransition(mode, current);
  await deps.getProviderQuery().setPermissionMode(mode);
  deps.getStateManager().setSessionMetadata((prev) => ({ ...prev, permissionMode: mode }));
  deps.pushSidebandEvent({ type: 'plan_mode', mode: mode === 'plan' ? 'plan' : 'default' });
}

/** Override the base system prompt on the live config and the provider. */
export function setSystemPrompt(basePrompt: string | undefined, deps: ConfigDeps): boolean {
  deps.setConfig((prev) => ({ ...prev, systemPrompt: basePrompt }));
  return deps.getProviderQuery().setSystemPrompt?.(basePrompt) ?? false;
}

/**
 * Update the session's working directory on the live config, the provider,
 * and the presence record so the worktree sweep's live-session guard stays
 * current. A born-named `afk -w` worktree is created on turn 1, AFTER
 * presence was written with the launch dir; without this update presence.cwd
 * stays stale and the sweep can't see that the worktree is in use.
 */
export function setCwd(cwd: string, deps: ConfigDeps): void {
  deps.setConfig((prev) => ({ ...prev, cwd }));
  deps.getProviderQuery().setCwd?.(cwd);
  const sessionId = deps.getConfig().sessionId;
  if (sessionId !== undefined) void updatePresenceCwd(sessionId, cwd);
}

/** Trigger a provider credential refresh. Returns null if unsupported. */
export async function reauth(deps: ConfigDeps): Promise<{ accountId: string; swapped: boolean } | null> {
  return (await deps.getProviderQuery().reauth?.()) ?? null;
}

/**
 * Return and CLEAR any implement-turn queued by an approved `exit_plan_mode`
 * tool call. Atomically applies the deferred permission-mode flip then returns
 * both the seed message and the mode it flipped to. Returns `undefined` when
 * nothing is pending or when the deferred flip rejected and the seed was dropped.
 */
export async function takePendingPlanExitSeed(
  deps: ConfigDeps,
): Promise<{ message: string; mode: PermissionMode } | undefined> {
  const seed = deps.getPlanExit().takeSeed();
  if (seed === undefined) return undefined;
  try {
    await setPermissionMode(seed.mode, deps);
  } catch (err) {
    debugLog(
      `⚠️ AgentSession: deferred plan-exit mode flip to '${seed.mode}' rejected; dropping implement-seed (staying in plan mode): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  return { message: seed.message, mode: seed.mode };
}
