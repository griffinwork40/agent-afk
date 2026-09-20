/**
 * Phase 1: Specification generation.
 * Forks a subagent to draft a detailed specification from the idea.
 */

import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import { forkMintPhase } from './_fork-phase.js';
import type { AgentModelInput } from '../../../agent/types.js';
import type { TraceSink } from '../../../agent/trace/index.js';
import type { WorkspaceStore } from '../../../agent/workspace/index.js';

export async function runSpecPhase(
  idea: string,
  parentSessionId: string,
  parentCwd?: string,
  // Mint skill's ToolCall id. When present, anchors the forked subagent
  // under the mint skill's tool-lane entry — see runResearchPhase / skills/index.ts.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
  // Read-scope inheritance (#547): the parent session's read roots, resolved
  // once by the mint handler (resolveChildManagerReadRoots). Seeded as the fork
  // manager's parentReadRoots so the phase subagent's read scope ⊇ the parent
  // session's — the same child ⊇ parent invariant the `agent` tool enforces
  // (#544). Undefined (the common case, where the mint worktree IS the session
  // cwd) leaves the manager's cwd-derivation intact.
  parentReadRoots?: string[],
  // Witness layer: parent trace writer (ctx.traceWriter) so this phase's fork
  // emits subagent_lifecycle events. Mirrors research.ts.
  traceWriter?: TraceSink,
  // Shared workspace (ctx.workspaceStore). Seeds the fork manager so this
  // phase's subagent receives the sibling-findings preamble
  // (injectWorkspacePreamble) — the workspace READ channel. Publishing already
  // works without it; reading does not. See skills/index.ts
  // SkillExecutionContext.workspaceStore.
  workspaceStore?: WorkspaceStore,
): Promise<string> {
  const prompts = loadSkillPrompts('mint');
  const specPrompt = prompts['spec.md'];

  if (!specPrompt) {
    throw new Error('mint skill missing spec.md prompt');
  }

  return forkMintPhase({
    phaseName: 'spec',
    phaseId: 'mint-spec',
    systemPrompt: specPrompt,
    inputMessage: `Create a detailed specification for: ${idea}`,
    phaseRole: 'read-only',
    parentSessionId,
    parentCwd,
    skillCallId,
    model: defaultSubagentModel,
    parentReadRoots,
    traceWriter,
    workspaceStore,
  });
}
