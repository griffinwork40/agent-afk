/**
 * Phase 3: Implementation planning.
 * Forks a subagent to create a detailed implementation plan.
 */

import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import { forkMintPhase } from './_fork-phase.js';
import type { AgentModelInput } from '../../../agent/types.js';
import type { TraceSink } from '../../../agent/trace/index.js';
import type { WorkspaceStore } from '../../../agent/workspace/index.js';

export async function runPlanPhase(
  spec: string,
  research: string,
  parentSessionId: string,
  parentCwd?: string,
  // Mint skill's ToolCall id — anchors the forked subagent under the mint
  // skill's tool-lane entry. See skills/index.ts SkillExecutionContext.callId.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
  // Read-scope inheritance (#547): parent session's read roots (resolved once
  // by the mint handler); seeds the fork manager's parentReadRoots so the phase
  // subagent's reads ⊇ the parent session's. Undefined leaves cwd-derivation.
  parentReadRoots?: string[],
  // Witness layer: parent trace writer (ctx.traceWriter) so this phase's fork
  // emits subagent_lifecycle events. Mirrors research.ts.
  traceWriter?: TraceSink,
  // Shared workspace (ctx.workspaceStore). Seeds the fork manager so this
  // phase's subagent receives the sibling-findings preamble
  // (injectWorkspacePreamble) — the workspace READ channel. Publishing already
  // works without it; reading does not. See spec.ts / skills/index.ts
  // SkillExecutionContext.workspaceStore.
  workspaceStore?: WorkspaceStore,
): Promise<string> {
  const prompts = loadSkillPrompts('mint');
  const planPrompt = prompts['plan.md'];

  if (!planPrompt) {
    throw new Error('mint skill missing plan.md prompt');
  }

  const planInput =
    `Specification:\n${spec}\n\nResearch findings:\n${research}\n\n` +
    `Create a detailed implementation plan based on the spec and research.`;

  return forkMintPhase({
    phaseName: 'plan',
    phaseId: 'mint-plan',
    systemPrompt: planPrompt,
    inputMessage: planInput,
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
