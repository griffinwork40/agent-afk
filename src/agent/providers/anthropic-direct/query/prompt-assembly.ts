/**
 * System-prompt assembly for one `AnthropicDirectProvider.query()` call.
 *
 * Extracted from `index.ts` (#824). Gathers the skill manifest, the tool and
 * memory prompt variants, and the awareness identity fields, then produces
 * both the STABLE (cwd-independent) parts and the assembled first-turn prompt.
 *
 * Contract: `stableSystemPrefix` is returned alongside the assembled string
 * because the cwd-rebuild path (`createCwdDependentsFactory`) re-runs
 * `assembleSystemPrompt` over those same parts on a `setCwd()`. Returning one
 * without the other would let the first-turn prompt and the rebuilt prompt
 * drift — which is exactly the bug that made the assembler a shared helper.
 *
 * @module agent/providers/anthropic-direct/query/prompt-assembly
 */

import type { AgentConfig } from '../../../types/config-types.js';
import type { RuntimeStateSource } from '../../../awareness/index.js';
import { buildSkillManifest } from '../../../tools/skill-bridge.js';
import {
  resolveToolSystemPrompt,
  resolveMemorySystemPrompt,
  resolveWorkspaceSystemPrompt,
} from '../../../tools/system-prompt.js';
import {
  assembleSystemPrompt,
  buildStableSystemPrefix,
  type StableSystemParts,
} from './system-prompt.js';

export interface PromptAssemblyArgs {
  config: AgentConfig;
  /** Session working directory (already defaulted to `process.cwd()`). */
  cwd: string;
  surface: string;
  readOnlyMemory: boolean;
  /** Whether workspace tools are enabled (store is wired). Gates inclusion of
   *  the workspace system prompt fragment. */
  workspaceEnabled: boolean;
  /** Present only when a skill executor is wired; gates manifest construction. */
  hasSkillExecutor: boolean;
  runtimeStateSource: RuntimeStateSource;
  /** User-supplied system prompt, already normalized to a string or null. */
  userSystem: string | null;
}

export interface AssembledPrompt {
  /** Cwd-independent parts, reused verbatim by the cwd-rebuild factory. */
  stableSystemPrefix: StableSystemParts;
  /** The assembled first-turn system prompt. */
  toolSystemAppend: string;
}

/** Build the stable prompt parts and assemble the first-turn system prompt. */
export function assembleQueryPrompt(args: PromptAssemblyArgs): AssembledPrompt {
  const { config, cwd } = args;

  // Build skill manifest for system prompt injection. The manifest lists
  // available skills so the model knows what the `skill` tool can invoke.
  // Let collectSkillEntries() own the full scan (project + user + bundled).
  // Pass the session cwd so project skills (<cwd>/.afk/skills/) resolve
  // against the session's working directory, not the host process's —
  // they diverge on long-lived hosts (daemon, Telegram bot).
  // `excludeName` omits the executing skill's own entry for a skill-dispatch
  // fork (see AgentConfig.skillDispatchName). Must stay in lockstep with the
  // openai-compatible call site — a per-provider divergence here is how a
  // fork on one provider silently keeps the self-entry.
  const manifest = args.hasSkillExecutor
    ? buildSkillManifest(undefined, {
        cwd,
        ...(typeof config.skillDispatchName === 'string' &&
        config.skillDispatchName.length > 0
          ? { excludeName: config.skillDispatchName }
          : {}),
      })
    : '';
  // Invariant: SLASH_COMMAND_ROUTING_PROMPT is omitted for skill-dispatch
  // sub-agents. Those sessions receive a "Run the <name> skill" directive
  // with no <command-name> tag, so the routing instruction (which keys off
  // that tag) would push them to ask "which skill?" instead of engaging with
  // their SKILL.md body. The ask_question strip in the dispatcher wiring is
  // the structural backstop for the same failure mode.
  const toolBase = resolveToolSystemPrompt(config.isSkillDispatch);
  // Read-only memory child sessions get a slimmed prompt that omits write
  // instructions for memory_update / procedure_write — keeps the model from
  // being told about tools it does not have.
  const memoryPrompt = resolveMemorySystemPrompt(args.readOnlyMemory);
  const workspacePrompt = resolveWorkspaceSystemPrompt(args.workspaceEnabled);

  // Awareness identity fields interleaved into the `# Environment` fragment
  // (Phase 1 + 2). The identity fields (surface/sessionId/depth/maxDepth) are
  // stable across cwd swaps; `workspace` is NOT — a different worktree is a
  // different branch and HEAD. It is re-read from the live source here and
  // again in `cwd-dependents.ts` on every setCwd, so it tracks the cwd rather
  // than freezing at the launch checkout.
  const environmentIdentity = {
    surface: args.surface,
    sessionId: config.sessionId,
    depth: config.depth,
    maxDepth: config.maxDepth,
    workspace: args.runtimeStateSource.getWorkspace(),
  };

  // Stable (cwd-independent) parts of the system prompt. The cwd-dependent
  // `# Environment` fragment is spliced in by assembleSystemPrompt — the same
  // helper the cwdDependentsFactory uses on a cwd change, so the first-turn
  // and rebuilt prompts can never drift.
  const stableSystemPrefix = buildStableSystemPrefix({
    toolBase,
    memoryPrompt,
    workspacePrompt,
    // Hot memory (HOT.md) rides its own config field, NOT prepended into
    // systemPrompt, so the assembler can place it after the memory
    // instructions rather than ahead of the # Agent AFK doctrine. Unset for
    // child sessions (subagents never inject hot memory) → treated as absent.
    hotMemory: config.hotMemory ?? '',
    manifest,
    userSystem: args.userSystem,
  });

  return {
    stableSystemPrefix,
    toolSystemAppend: assembleSystemPrompt(stableSystemPrefix, cwd, environmentIdentity),
  };
}
