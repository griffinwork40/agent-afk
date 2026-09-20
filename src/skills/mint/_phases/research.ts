/**
 * Phase 2: Research context gathering.
 * Forks a subagent to gather codebase and architectural context.
 */

import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import { forkMintPhase } from './_fork-phase.js';
import type { AgentModelInput } from '../../../agent/types.js';
import type { TraceSink } from '../../../agent/trace/index.js';
import type { WorkspaceStore } from '../../../agent/workspace/index.js';

export async function runResearchPhase(
  spec: string,
  parentSessionId: string,
  parentCwd?: string,
  // Mint skill's ToolCall id. When present, anchors the forked subagent
  // under the mint skill's tool-lane entry so the live overlay AND scrollback
  // block both nest correctly. See skills/index.ts SkillExecutionContext.callId.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
  // Read-scope inheritance (#547): parent session's read roots (resolved once
  // by the mint handler); seeds the fork manager's parentReadRoots so the phase
  // subagent's reads ⊇ the parent session's. Undefined leaves cwd-derivation.
  parentReadRoots?: string[],
  // Witness layer: the parent session's trace writer (from ctx.traceWriter).
  // Without it this phase's fork manager has no writer, so its subagent emits
  // NO subagent_lifecycle events — mint phases were the last dispatch path
  // still invisible in the trace. Mirrors the root/skill-fork managers.
  traceWriter?: TraceSink,
  // Shared workspace (ctx.workspaceStore). Seeds the fork manager so this
  // phase's subagent receives the sibling-findings preamble
  // (injectWorkspacePreamble) — the workspace READ channel. Publishing already
  // works without it; reading does not. See spec.ts / skills/index.ts
  // SkillExecutionContext.workspaceStore.
  workspaceStore?: WorkspaceStore,
): Promise<string> {
  const prompts = loadSkillPrompts('mint');
  const researchPrompt = prompts['research.md'];

  if (!researchPrompt) {
    throw new Error('mint skill missing research.md prompt');
  }

  return forkMintPhase({
    phaseName: 'research',
    phaseId: 'mint-research',
    systemPrompt: researchPrompt,
    inputMessage: `Gather context and research for this specification:\n\n${spec}`,
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
