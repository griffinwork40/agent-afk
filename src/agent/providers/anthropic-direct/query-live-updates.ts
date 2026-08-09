import { pathContainmentBypassed } from '../../permission-policy.js';
import { resolveModelId } from '../../session/model-resolution.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import type { SessionState } from './query/session-state.js';

/**
 * Apply a live model change without resetting the query session.
 *
 * `model` is the requested alias or full id; the state keeps both the requested
 * value for context-window lookup and the resolved wire id for Anthropic calls.
 */
export function setLiveModel(state: SessionState, model?: string): void {
  if (model === undefined || model.length === 0) return;
  state.requestedModel = model;
  state.currentModel = resolveModelId(model) ?? model;
}

/**
 * Apply a live permission-mode change to both enforcement paths.
 *
 * File tools read `toolDispatcher.allowAll`; approval hooks read provider grants
 * via `onPermissionMode`. Keeping both in sync prevents unsafe half-toggles.
 */
export function setLivePermissionMode(options: {
  state: SessionState;
  mode: string;
  onPermissionMode?: (mode: string) => void;
}): void {
  const { state, mode, onPermissionMode } = options;
  state.currentPermissionMode = mode;
  state.toolDispatcher.setAllowAll?.(pathContainmentBypassed(mode));
  onPermissionMode?.(mode);
}

/**
 * Refresh cwd-dependent query state in place.
 *
 * The current dispatcher is mutated first so any in-flight turn that captured it
 * by reference sees the new resolve base on its next handler-context read. When
 * a rebuild factory is available, the next turn also receives a freshly rendered
 * system prompt and dispatcher closed over the new cwd.
 */
export function setLiveCwd(options: {
  state: SessionState;
  cwd: string;
  cwdDependentsFactory?: (cwd: string) => { userSystem: string; dispatcher: ToolDispatcher };
}): void {
  const { state, cwd, cwdDependentsFactory } = options;
  state.toolDispatcher.setResolveBase?.(cwd);
  if (!cwdDependentsFactory) return;
  const { userSystem, dispatcher } = cwdDependentsFactory(cwd);
  state.userSystem = userSystem;
  state.toolDispatcher = dispatcher;
}

/** Swap the composed base system prompt for all subsequent turns. */
export function setLiveSystemPrompt(options: {
  state: SessionState;
  basePrompt: string | undefined;
  systemPromptRebuildFactory?: (basePrompt: string | undefined) => string;
}): boolean {
  const { state, basePrompt, systemPromptRebuildFactory } = options;
  if (!systemPromptRebuildFactory) return false;
  state.userSystem = systemPromptRebuildFactory(basePrompt);
  return true;
}
