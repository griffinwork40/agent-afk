/**
 * Phase 8: Ship.
 * Creates a summary and return result.
 */

import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import { forkMintPhase } from './_fork-phase.js';
import { emitCard } from '../../_lib/emit-card.js';
import type { AgentModelInput } from '../../../agent/types.js';
import type { TraceSink } from '../../../agent/trace/index.js';
import type { WorkspaceStore } from '../../../agent/workspace/index.js';
import type { MintState } from '../index.js';

export async function runShipPhase(
  state: MintState,
  parentSessionId: string,
  parentCwd?: string,
  // Mint skill's ToolCall id — anchors the ship subagent under the mint
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
  const shipPrompt = prompts['ship.md'];

  if (!shipPrompt) {
    throw new Error('mint skill missing ship.md prompt');
  }

  // Propagate parent worktree — ship subagent may run `git status`/`git
  // log` and needs to see the right working tree.
  const shipInput =
    `Idea: ${state.idea}\n\n` +
    `Specification:\n${state.spec}\n\n` +
    `Plan:\n${state.plan}\n\n` +
    `Build results:\n${JSON.stringify(state.buildResults, null, 2)}\n\n` +
    `Verification results:\n${JSON.stringify(state.verifyResults, null, 2)}\n\n` +
    `Heal iterations used: ${state.healIterations}\n\n` +
    `Create a ship-ready summary with next steps.`;

  // No phaseRole — ship legitimately runs git commands and may emit output.
  const summary = await forkMintPhase({
    phaseName: 'ship',
    phaseId: 'mint-ship',
    systemPrompt: shipPrompt,
    inputMessage: shipInput,
    parentSessionId,
    parentCwd,
    skillCallId,
    model: defaultSubagentModel,
    parentReadRoots,
    traceWriter,
    workspaceStore,
  });

  const filesChanged = state.buildResults?.filesChanged.length ?? 0;
  const healIters = state.healIterations;

  emitCard({
    kind: 'checkpoint',
    title: 'ship — done',
    body: [
      `Files changed: ${filesChanged}`,
      `Heal iterations: ${healIters}`,
      `Idea: ${state.idea}`,
    ],
  });

  return summary;
}
