/**
 * Phase 8: Ship.
 * Creates a summary and return result.
 */

import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure, isIncompleteStopReason } from '../../../agent/subagent/result.js';
import { resolveCredentialForModel } from '../../../agent/auth/credential-resolver.js';
import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import type { AgentModelInput } from '../../../agent/types.js';
import { emitCard } from '../../_lib/emit-card.js';
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
): Promise<string> {
  const prompts = loadSkillPrompts('mint');
  const shipPrompt = prompts['ship.md'];

  if (!shipPrompt) {
    throw new Error('mint skill missing ship.md prompt');
  }

  // Propagate parent worktree — ship subagent may run `git status`/`git
  // log` and needs to see the right working tree.
  const manager = new SubagentManager({
    ...(parentCwd !== undefined ? { cwd: parentCwd } : {}),
    ...(parentReadRoots !== undefined ? { parentReadRoots } : {}),
  });
  const shipHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: defaultSubagentModel,
      systemPrompt: shipPrompt,
      apiKey: resolveCredentialForModel(defaultSubagentModel),
    },
    idPrefix: 'mint-ship',
    agentType: 'mint-ship',
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  const shipInput =
    `Idea: ${state.idea}\n\n` +
    `Specification:\n${state.spec}\n\n` +
    `Plan:\n${state.plan}\n\n` +
    `Build results:\n${JSON.stringify(state.buildResults, null, 2)}\n\n` +
    `Verification results:\n${JSON.stringify(state.verifyResults, null, 2)}\n\n` +
    `Heal iterations used: ${state.healIterations}\n\n` +
    `Create a ship-ready summary with next steps.`;

  const shipResult = await shipHandle.runToResult(shipInput);

  if (shipResult.status !== 'succeeded' || !shipResult.message) {
    throw new Error(`ship phase failed: ${describeFailure(shipResult)}`);
  }
  // A `succeeded` result can still be an incomplete partial — the tool-use cap
  // fired or the stream closed without a terminal message. Its `.message.content`
  // is a truncated placeholder, not the real ship summary, so hard-fail before
  // emitting the card or returning the partial as the phase output.
  if (isIncompleteStopReason(shipResult.stopReason)) {
    throw new Error(
      `ship phase returned an incomplete result (stopReason=${shipResult.stopReason})`,
    );
  }

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

  return shipResult.message.content;
}
