/**
 * Live system-prompt rebuild helper for {@link AnthropicDirectProvider.query}.
 *
 * Sibling of `cwd-dependents.ts`: that module rebuilds the system prompt when
 * the *cwd* changes, this one rebuilds it when the *operator overlay* changes
 * (the `/afk-md` hot-reload path). Both funnel through the SAME
 * `assembleSystemPrompt` assembler so the first-turn prompt, the cwd-rebuilt
 * prompt, and the overlay-rebuilt prompt can never drift apart.
 *
 * @module agent/providers/anthropic-direct/query/overlay-rebuild
 */

import type { AgentConfig } from '../../../types/config-types.js';
import type { RuntimeStateSource } from '../../../awareness/index.js';
import { assembleSystemPrompt, type StableSystemParts } from './system-prompt.js';

/**
 * Rebuild the assembled system prompt around a new composed base prompt.
 *
 * Returns the full string to install into `SessionState.userSystem`.
 */
export type SystemPromptRebuildFactory = (basePrompt: string | undefined) => string;

export interface SystemPromptRebuildFactoryArgs {
  /**
   * The SAME `StableSystemParts` instance handed to `createCwdDependentsFactory`.
   * Sharing the object is load-bearing — see the Invariant in the factory body.
   */
  stableSystemPrefix: StableSystemParts;
  config: AgentConfig;
  surface: string;
  runtimeStateSource: RuntimeStateSource;
  /** Live cwd accessor — the provider's `_currentCwd`, which `setCwd()` updates. */
  getCurrentCwd: () => string | undefined;
  /** Session cwd captured at `query()` entry; used when the live accessor is unset. */
  fallbackCwd: string;
}

/** Build the systemPromptRebuildFactory passed to AnthropicDirectQuery. */
export function createSystemPromptRebuildFactory(
  args: SystemPromptRebuildFactoryArgs,
): SystemPromptRebuildFactory {
  return (basePrompt: string | undefined): string => {
    // Invariant: the new base prompt is written back into the SHARED
    // `stableSystemPrefix` object, in place, BEFORE re-assembly — never into a
    // local copy.
    //
    // `createCwdDependentsFactory` closes over this same instance by reference
    // and re-runs `assembleSystemPrompt` over it on every `setCwd()`. If we
    // assembled from a copy and left the shared object holding the old text,
    // the next cwd change (a `/cd`, or the first-turn worktree autoname hook)
    // would silently resurrect the pre-edit prompt and quietly undo the
    // operator's hot-reload. Mutating the shared parts makes the two rebuild
    // paths compose instead of fight: whichever runs last, both the current cwd
    // and the current overlay survive.
    //
    // Normalizing empty-string to null matches `resolveUserSystem()` and the
    // assembler's own `if (parts.userSystem)` skip, so "overlay cleared" drops
    // the section entirely rather than emitting a stray blank block.
    args.stableSystemPrefix.userSystem =
      basePrompt !== undefined && basePrompt.length > 0 ? basePrompt : null;

    // Ordering constraint (externally governed, same as cwd-dependents.ts step 2):
    // `workspace` is NOT stable — it tracks the live checkout's branch and HEAD —
    // so it must be re-read from the runtime source at rebuild time rather than
    // reused from a construction-time snapshot. The cwd is read live for the same
    // reason: an overlay edit may land after a `/cd` or a worktree re-anchor.
    const cwd = args.getCurrentCwd() ?? args.fallbackCwd;
    return assembleSystemPrompt(args.stableSystemPrefix, cwd, {
      surface: args.surface,
      sessionId: args.config.sessionId,
      depth: args.config.depth,
      maxDepth: args.config.maxDepth,
      workspace: args.runtimeStateSource.getWorkspace(),
    });
  };
}
