/**
 * System-prompt assembly helpers for `OpenAICompatibleProvider.query()`.
 *
 * Extracted from `index.ts` to keep `query()` within the 200-line function
 * ceiling (AFK.md convention; `pnpm audit:funcsize:check` is the gate). The
 * helpers here take EXPLICIT parameters — no closures over `query()` locals —
 * so behaviour is identical and the module-state checker is satisfied.
 *
 * @module agent/providers/openai-compatible/index.system-prompt
 */

import type { AgentConfig } from '../../types/config-types.js';
import {
  resolveToolSystemPrompt,
  resolveMemorySystemPrompt,
  resolveWorkspaceSystemPrompt,
} from '../../tools/system-prompt.js';
import { buildSkillManifest } from '../../tools/skill-bridge.js';
import {
  formatEnvironmentFragment,
  type RuntimeStateSource,
} from '../../awareness/index.js';

/** Mutable cell shared between `onCwdChange` and `systemPromptRebuildFactory`. */
export interface BasePromptRef {
  current: string | undefined;
}

/** Parameters accepted by {@link buildSystemPromptHooks}. */
export interface SystemPromptHookParams {
  config: AgentConfig;
  resolvedSessionId: string | undefined;
  surface: string;
  runtimeStateSource: RuntimeStateSource;
  hasWorkspaceStore: boolean;
  hasSkillExecutor: boolean;
  readOnlyMemory: boolean | undefined;
  readOnlyState: boolean | undefined;
  /** Live getter for the mutable cwd cell that lives in `query()`. */
  getCurrentCwd: () => string;
  /**
   * Called by `onCwdChange` to update `_currentCwd` (in `query()`) and
   * `_sharedCurrentCwd` (on the provider instance) atomically. Passed as an
   * explicit callback so this helper needs no reference to `this`.
   */
  applyNewCwd: (newCwd: string) => void;
}

/** Return value of {@link buildSystemPromptHooks}. */
export interface SystemPromptHooks {
  /** Rebuilt config with the initial system prompt injected. */
  patchedConfig: AgentConfig;
  /** Assigned to `buildOpts.onCwdChange` — rebuilds env block on cwd change. */
  onCwdChange: (newCwd: string) => void;
  /** Assigned to `buildOpts.systemPromptRebuildFactory`. */
  systemPromptRebuildFactory: (base?: string) => string;
  /** Mutable ref that tracks the most recent `setSystemPrompt(base)` value. */
  baseRef: BasePromptRef;
}

/**
 * Assembles the per-query system-prompt machinery for the openai-compatible
 * provider: stable fragments, the cwd-dependent `# Environment` block, and
 * the two rebuild callbacks wired to `buildOpts`.
 *
 * Contract: behaviour is identical to the inline code that previously lived in
 * `query()`. All mutable state is threaded via explicit parameters — no
 * closures over caller locals — consistent with the project's no-hidden-
 * singleton rule.
 */
export function buildSystemPromptHooks(p: SystemPromptHookParams): SystemPromptHooks {
  const {
    config,
    resolvedSessionId,
    surface,
    runtimeStateSource,
    hasWorkspaceStore,
    hasSkillExecutor,
    readOnlyMemory,
    readOnlyState,
    getCurrentCwd,
    applyNewCwd,
  } = p;

  // Invariant: kept in lockstep with anthropic-direct's call site.
  // `excludeName` omits the executing skill's own entry for a skill-dispatch
  // fork (AgentConfig.skillDispatchName); `cwd` is forwarded so project skills
  // resolve against the session's dir, not the host process's (#876).
  const toolBase = resolveToolSystemPrompt(config.isSkillDispatch);
  const memoryPrompt = resolveMemorySystemPrompt(readOnlyMemory, readOnlyState);
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
  const existingSys = typeof config.systemPrompt === 'string' ? config.systemPrompt : undefined;

  // Contract: given the cwd-dependent `# Environment` fragment, return the
  // full joined system prompt over the STABLE fragments captured above.
  // Used both for the initial build and for every #876 rebuild, so the two
  // can never drift out of ordering sync with each other.
  const assembleSystemPrompt = (envFragment: string, baseSys = existingSys): string => {
    const parts = [toolBase];
    if (baseSys !== undefined && baseSys.length > 0) parts.push(baseSys);
    parts.push(memoryPrompt);
    const workspacePrompt = resolveWorkspaceSystemPrompt(hasWorkspaceStore);
    if (workspacePrompt) parts.push(workspacePrompt);
    for (const frag of [hotMemory, goalPrompt]) {
      if (frag.length > 0) parts.push(frag);
    }
    parts.push(envFragment);
    if (manifest.length > 0) parts.push(manifest);
    return parts.join('\n\n');
  };

  // Phase 2 — the `# Environment` block. Uses `resolvedSessionId` (not
  // `config.sessionId`) so the block shows the resolved id (#2353).
  const buildEnvFragment = (): string =>
    formatEnvironmentFragment({
      cwd: getCurrentCwd(),
      ...(resolvedSessionId !== undefined ? { sessionId: resolvedSessionId } : {}),
      surface,
      ...(config.depth !== undefined ? { depth: config.depth } : {}),
      ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
      workspace: runtimeStateSource.getWorkspace(),
    });

  const patchedConfig: AgentConfig = {
    ...config,
    systemPrompt: assembleSystemPrompt(buildEnvFragment()),
  };

  // Invariant (#2420 P1): `baseRef` is a mutable cell shared between
  // `onCwdChange` and `systemPromptRebuildFactory`. `setSystemPrompt(base)` on
  // the query stores `base` into the ref so that a subsequent `setCwd()` rebuild
  // uses the REPLACEMENT base prompt — not the construction-time default. Without
  // this shared ref, `setSystemPrompt(newBase)` works only until the next
  // `setCwd()`, which would silently resurrect the old base prompt.
  const baseRef: BasePromptRef = { current: undefined };

  // Invariant (#876 + #2420): ordering is load-bearing — `applyNewCwd` updates
  // the cwd cell FIRST, then `buildEnvFragment()` re-reads `getWorkspace()` via
  // `getCurrentCwd()` — updating after the read would compute the workspace
  // snapshot for the OLD directory (mirrors anthropic-direct's cwd-dependents.ts
  // ordering invariant). `patchedConfig.systemPrompt` is reassigned IN PLACE so
  // the next turn's `buildMessages` picks up the new string with no further
  // plumbing.
  const onCwdChange = (newCwd: string): void => {
    applyNewCwd(newCwd);
    patchedConfig.systemPrompt = assembleSystemPrompt(buildEnvFragment(), baseRef.current);
  };

  const systemPromptRebuildFactory = (base?: string): string => {
    baseRef.current = base;
    return assembleSystemPrompt(buildEnvFragment(), base);
  };

  return { patchedConfig, onCwdChange, systemPromptRebuildFactory, baseRef };
}
