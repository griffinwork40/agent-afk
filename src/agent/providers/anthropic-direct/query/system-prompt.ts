/**
 * System-prompt assembly for {@link AnthropicDirectProvider.query}.
 *
 * The first-turn assembly (in `index.ts`) and the on-cwd-change re-assembly (in
 * `cwd-dependents.ts`) build the SAME structure — `[toolBase, memoryPrompt,
 * <# Environment fragment>, manifest?, userSystem?]` joined by blank lines.
 * Only the `# Environment` fragment varies with cwd. Centralizing both paths
 * here closes the "assembled twice" duplication so they can never drift.
 *
 * @module agent/providers/anthropic-direct/query/system-prompt
 */

import { formatEnvironmentFragment, type RuntimeStateSource } from '../../../awareness/index.js';

/** The cwd-independent system-prompt parts feeding both assembly paths. */
export interface StableSystemPromptInputs {
  toolBase: string;
  memoryPrompt: string;
  /** Skill/agent manifest block; empty string when none. */
  manifest: string;
  /** Operator system-prompt overlay; empty string or null when none. */
  userSystem: string | null;
}

/**
 * The cwd-independent prefix, in order: `[toolBase, memoryPrompt, manifest?,
 * userSystem?]`. The cwd-dependent `# Environment` fragment is deliberately NOT
 * included — {@link assembleSystemPrompt} splices it in at index 2 so it can be
 * recomputed on every cwd change without rebuilding the stable parts.
 */
export function buildStableSystemPrefix(i: StableSystemPromptInputs): string[] {
  const parts = [i.toolBase, i.memoryPrompt];
  if (i.manifest.length > 0) parts.push(i.manifest);
  if (i.userSystem) parts.push(i.userSystem);
  return parts;
}

/**
 * Awareness identity fields interleaved into the `# Environment` fragment.
 * These are stable across cwd swaps (captured at session start); only `cwd`
 * itself changes on a `setCwd()`.
 */
export interface EnvironmentIdentity {
  surface: string;
  sessionId: string | undefined;
  depth: number | undefined;
  maxDepth: number | undefined;
  workspace: ReturnType<RuntimeStateSource['getWorkspace']>;
}

/**
 * Assemble the full system prompt: splice the cwd-dependent `# Environment`
 * fragment into position 2 of the stable prefix and join with blank lines.
 *
 * `formatEnvironmentFragment` always emits `- Working directory: <cwd>`,
 * conditionally appends `- Session: <id> (...)` when an identity field is
 * known, and conditionally appends `- Workspace: <branch> @ <sha> (...)` when
 * git state is available. Used by the first-turn path (`index.ts`) and by every
 * cwd rebuild (`cwd-dependents.ts`) so the two never diverge.
 */
export function assembleSystemPrompt(
  stableSystemPrefix: string[],
  cwd: string,
  identity: EnvironmentIdentity,
): string {
  const parts = [
    stableSystemPrefix[0]!,
    stableSystemPrefix[1]!,
    formatEnvironmentFragment({
      cwd,
      ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
      surface: identity.surface,
      ...(identity.depth !== undefined ? { depth: identity.depth } : {}),
      ...(identity.maxDepth !== undefined ? { maxDepth: identity.maxDepth } : {}),
      workspace: identity.workspace,
    }),
    ...stableSystemPrefix.slice(2),
  ];
  return parts.join('\n\n');
}
