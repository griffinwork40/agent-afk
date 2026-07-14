/**
 * System-prompt assembly for {@link AnthropicDirectProvider.query}.
 *
 * The first-turn assembly (in `index.ts`) and the on-cwd-change re-assembly (in
 * `cwd-dependents.ts`) build the SAME structure via {@link assembleSystemPrompt}
 * so the two can never drift. Only the `# Environment` fragment varies with cwd.
 *
 * Invariant: top-level order is
 *   `[toolBase, userSystem?, memoryPrompt, hotMemory?, <# Environment>, manifest?]`.
 * The `# Agent AFK` doctrine + operator overlay travel in `userSystem` and are
 * placed EARLY — right after the tool/runtime conventions and before the
 * cross-session memory (instructions + hot-memory project context) and the
 * skill manifest — so the operating posture is established before the reference
 * material.
 *
 * @module agent/providers/anthropic-direct/query/system-prompt
 */

import { formatEnvironmentFragment, type RuntimeStateSource } from '../../../awareness/index.js';

/** The cwd-independent system-prompt parts feeding both assembly paths. */
export interface StableSystemPromptInputs {
  toolBase: string;
  memoryPrompt: string;
  /**
   * `<cross-session-memory>` hot-memory block (project context); empty string
   * when none. Placed in the cross-session-memory region, after `memoryPrompt`.
   */
  hotMemory: string;
  /** Skill/agent manifest block; empty string when none. */
  manifest: string;
  /** Operator system-prompt overlay; empty string or null when none. */
  userSystem: string | null;
}

/**
 * The cwd-independent named parts, captured once and reused across every cwd
 * rebuild. The cwd-dependent `# Environment` fragment is deliberately NOT
 * included — {@link assembleSystemPrompt} splices it in on each cwd change
 * without rebuilding the stable parts.
 */
export type StableSystemParts = StableSystemPromptInputs;

/**
 * Capture the cwd-independent named parts. A thin normalizer today; kept as the
 * single construction point so the first-turn and cwd-rebuild paths share one
 * shape. Ordering of the parts is owned by {@link assembleSystemPrompt}.
 */
export function buildStableSystemPrefix(i: StableSystemPromptInputs): StableSystemParts {
  return i;
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
 * Assemble the full system prompt from the cwd-independent parts plus the
 * cwd-dependent `# Environment` fragment, joined by blank lines.
 *
 * Order (see the module Invariant):
 *   1. `toolBase`     — tool/runtime conventions
 *   2. `userSystem`   — `# Agent AFK` doctrine + operator overlay + directives
 *   3. `memoryPrompt` — cross-session-memory instructions
 *   4. `hotMemory`    — `<cross-session-memory>` project-context block
 *   5. `# Environment`— cwd/session/workspace (recomputed per cwd)
 *   6. `manifest`     — skill/agent catalog
 * Optional parts (`userSystem`, `hotMemory`, `manifest`) are skipped when
 * empty; `# Environment` is inserted before `manifest` by name rather than a
 * fixed index, so it stays correctly positioned regardless of which optional
 * parts are present.
 *
 * `formatEnvironmentFragment` always emits `- Working directory: <cwd>`,
 * conditionally appends `- Session: <id> (...)` when an identity field is
 * known, and conditionally appends `- Workspace: <branch> @ <sha> (...)` when
 * git state is available. Used by the first-turn path (`index.ts`) and by every
 * cwd rebuild (`cwd-dependents.ts`) so the two never diverge.
 */
export function assembleSystemPrompt(
  parts: StableSystemParts,
  cwd: string,
  identity: EnvironmentIdentity,
): string {
  const environment = formatEnvironmentFragment({
    cwd,
    ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
    surface: identity.surface,
    ...(identity.depth !== undefined ? { depth: identity.depth } : {}),
    ...(identity.maxDepth !== undefined ? { maxDepth: identity.maxDepth } : {}),
    workspace: identity.workspace,
  });
  const ordered: string[] = [parts.toolBase];
  if (parts.userSystem) ordered.push(parts.userSystem);
  ordered.push(parts.memoryPrompt);
  if (parts.hotMemory.length > 0) ordered.push(parts.hotMemory);
  ordered.push(environment);
  if (parts.manifest.length > 0) ordered.push(parts.manifest);
  return ordered.join('\n\n');
}
