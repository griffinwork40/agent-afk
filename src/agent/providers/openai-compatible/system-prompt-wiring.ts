/**
 * System-prompt assembly and cwd-rebuild wiring for one
 * `OpenAICompatibleProvider.query()` call.
 *
 * Extracted from `index.ts` (#2711/#2721 ratchet-collision fix) so the
 * fragment-collection, assembly, and cwd-/base-rebuild factories live in one
 * place and the `query()` body stays within the function-size ceiling.
 *
 * Ordering mirrors AnthropicDirectProvider.query():
 *   [toolBase, userSystem?, memoryPrompt, workspace?, hotMemory?, goalPrompt?,
 *    envFragment, manifest?]
 *
 * `envFragment` is the ONLY cwd-dependent piece — see `buildSystemPromptWiring`
 * below (#876) for why the rest are computed once and treated as stable across
 * a cwd re-anchor.
 *
 * @module agent/providers/openai-compatible/system-prompt-wiring
 */

import type { AgentConfig } from '../../types/config-types.js';
import type { RuntimeStateSource } from '../../awareness/index.js';
import { formatEnvironmentFragment } from '../../awareness/index.js';
import {
  resolveToolSystemPrompt,
  resolveMemorySystemPrompt,
  resolveWorkspaceSystemPrompt,
} from '../../tools/system-prompt.js';
import { buildSkillManifest } from '../../tools/skill-bridge.js';
import { normalizeSystemPromptOverlay } from '../shared/system-prompt.js';

/**
 * Parameters forwarded from `query()` — all explicit, no closure over locals.
 */
export interface SystemPromptWiringArgs {
  config: AgentConfig;
  /** Whether a skill executor is present (controls manifest inclusion). */
  hasSkillExecutor: boolean;
  /** Whether a workspace store is present (controls workspace fragment). */
  hasWorkspaceStore: boolean;
  /** Whether the memory store is read-only. */
  readOnlyMemory: boolean | undefined;
  /** Whether the state store is read-only. */
  readOnlyState: boolean | undefined;
  /**
   * Stable resolved session id for the `# Environment` block (#2353).
   * `config.sessionId` is absent on fresh telegram/daemon sessions; use the
   * resolved id from `resolveSessionId` instead.
   */
  resolvedSessionId: string | undefined;
  /** Surface tag forwarded from provider options. */
  surface: string;
  /** Getter for the current mutable cwd cell inside query(). */
  getCurrentCwd: () => string;
  /** Awareness source used to read the workspace snapshot. */
  runtimeStateSource: RuntimeStateSource;
}

/**
 * Result returned to `query()` for wiring into `buildOpts`.
 */
export interface SystemPromptWiringResult {
  /** Fully assembled system prompt for the initial turn. */
  initialSystemPrompt: string;
  /**
   * Re-assembles the system prompt after a `setCwd()` call. The caller MUST
   * update `_currentCwd` BEFORE invoking this so `getCurrentCwd()` returns the
   * new directory (load-bearing ordering — mirrors anthropic-direct's
   * cwd-dependents.ts invariant). The caller assigns the return value into
   * `patchedConfig.systemPrompt` in-place.
   */
  rebuildAfterCwdChange: () => string;
  /**
   * Factory for `buildOpts.systemPromptRebuildFactory`. Stores the new base
   * prompt in `_currentBaseRef` so a subsequent `setCwd()` rebuild uses the
   * replacement base, not the construction-time default (#2420 P1 invariant).
   */
  systemPromptRebuildFactory: (base: string | undefined) => string;
}

/**
 * Collect system-prompt fragments and return the assembled initial prompt plus
 * the cwd-/base-rebuild factories needed by `buildQueryFromConfig`.
 *
 * All parameters are explicit — no closure over `query()` locals. The mutable
 * `_currentCwd` cell is read via `getCurrentCwd` (a getter the caller provides),
 * and the mutable `_currentBaseRef` cell is owned here and shared between
 * `rebuildAfterCwdChange` and `systemPromptRebuildFactory`.
 */
export function buildSystemPromptWiring(args: SystemPromptWiringArgs): SystemPromptWiringResult {
  const {
    config, hasSkillExecutor, hasWorkspaceStore, readOnlyMemory, readOnlyState,
    resolvedSessionId, surface, getCurrentCwd, runtimeStateSource,
  } = args;

  // --- Stable fragments (computed once; not cwd-dependent) ---
  const toolBase = resolveToolSystemPrompt(config.isSkillDispatch);
  const memoryPrompt = resolveMemorySystemPrompt(readOnlyMemory, readOnlyState);
  // Invariant: kept in lockstep with anthropic-direct's call site.
  // `excludeName` omits the executing skill's own entry for a skill-dispatch
  // fork (AgentConfig.skillDispatchName); `cwd` is forwarded so project skills
  // resolve against the session's dir, not the host process's (#876).
  const manifest = hasSkillExecutor
    ? buildSkillManifest(undefined, {
        ...(typeof config.cwd === 'string' && config.cwd.length > 0
          ? { cwd: config.cwd }
          : {}),
        ...(typeof config.skillDispatchName === 'string' &&
        config.skillDispatchName.length > 0
          ? { excludeName: config.skillDispatchName }
          : {}),
      })
    : '';
  const hotMemory = typeof config.hotMemory === 'string' ? config.hotMemory : '';
  const goalPrompt = typeof config.goalPrompt === 'string' ? config.goalPrompt : '';
  // Fix #3261: use the shared normalizer so a preset { append } is forwarded,
  // not silently dropped. Previously `typeof ... === 'string'` discarded the
  // `append` text of preset objects.
  const existingSys = normalizeSystemPromptOverlay(config.systemPrompt) ?? undefined;

  // Mutable cell shared between rebuildAfterCwdChange and systemPromptRebuildFactory.
  // Invariant (#2420 P1): `setSystemPrompt(base)` on the query stores `base`
  // here via `systemPromptRebuildFactory` so that a subsequent `setCwd()`
  // rebuild uses the REPLACEMENT base prompt — not the construction-time default.
  // Without this shared ref, `setSystemPrompt(newBase)` works only until the
  // next `setCwd()`, which would silently resurrect the old base prompt.
  //
  // `set` tracks whether systemPromptRebuildFactory has ever been called (#3305).
  // We cannot use `current === undefined` as that sentinel because the factory
  // may be called with `undefined` (explicit clear), leaving both the
  // never-called and cleared states looking identical.
  const _currentBaseRef: { set: boolean; current: string | undefined } = {
    set: false,
    current: undefined,
  };

  /** Build the cwd-dependent `# Environment` fragment. */
  const buildEnvFragment = (): string =>
    formatEnvironmentFragment({
      cwd: getCurrentCwd(),
      ...(resolvedSessionId !== undefined ? { sessionId: resolvedSessionId } : {}),
      surface,
      ...(config.depth !== undefined ? { depth: config.depth } : {}),
      ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
      workspace: runtimeStateSource.getWorkspace(),
    });

  /**
   * Join all fragments into the full system prompt.
   *
   * `resolvedBase` is the already-resolved base overlay (string or undefined
   * for "cleared"). The caller is responsible for deciding which base to pass:
   * construction-time `existingSys`, the stored `_currentBaseRef.current`,
   * or a new value. There is no default parameter — this function does not
   * distinguish "no arg" from "explicit undefined".
   */
  const assemble = (envFragment: string, resolvedBase: string | undefined): string => {
    const parts = [toolBase];
    if (resolvedBase !== undefined && resolvedBase.length > 0) parts.push(resolvedBase);
    parts.push(memoryPrompt);
    const workspacePrompt = resolveWorkspaceSystemPrompt(hasWorkspaceStore);
    if (workspacePrompt) parts.push(workspacePrompt);
    for (const frag of [hotMemory, goalPrompt]) { if (frag.length > 0) parts.push(frag); }
    parts.push(envFragment);
    if (manifest.length > 0) parts.push(manifest);
    return parts.join('\n\n');
  };

  return {
    initialSystemPrompt: assemble(buildEnvFragment(), existingSys),
    rebuildAfterCwdChange: (): string => {
      // Contract: when systemPromptRebuildFactory was never called (`set` is
      // false), fall back to the construction-time `existingSys` so the preset
      // append is preserved. When it WAS called (even with `undefined` to
      // clear), use the stored value — which may be `undefined`, meaning
      // "cleared". This is the fix for #3305.
      const base = _currentBaseRef.set ? _currentBaseRef.current : existingSys;
      return assemble(buildEnvFragment(), base);
    },
    systemPromptRebuildFactory: (base: string | undefined): string => {
      _currentBaseRef.set = true;
      _currentBaseRef.current = base;
      return assemble(buildEnvFragment(), base);
    },
  };
}
