/**
 * Phase 2: Research context gathering.
 * Forks a subagent to gather codebase and architectural context.
 */

import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure } from '../../../agent/subagent/result.js';
import { getApiKey } from '../../../cli/shared-helpers.js';
import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import type { AgentModelInput } from '../../../agent/types.js';

export async function runResearchPhase(
  spec: string,
  parentSessionId: string,
  parentCwd?: string,
  // Mint skill's ToolCall id. When present, anchors the forked subagent
  // under the mint skill's tool-lane entry so the live overlay AND scrollback
  // block both nest correctly. See skills/index.ts SkillExecutionContext.callId.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
): Promise<string> {
  const prompts = loadSkillPrompts('mint');
  const researchPrompt = prompts['research.md'];

  if (!researchPrompt) {
    throw new Error('mint skill missing research.md prompt');
  }

  // Propagate parent worktree to subagent — see spec.ts for rationale.
  const manager = new SubagentManager(
    parentCwd !== undefined ? { cwd: parentCwd } : {},
  );
  const researchHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: defaultSubagentModel,
      systemPrompt: researchPrompt,
      apiKey: getApiKey(),
    },
    idPrefix: 'mint-research',
    phaseRole: 'read-only',
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  const researchResult = await researchHandle.runToResult(
    `Gather context and research for this specification:\n\n${spec}`,
  );

  if (researchResult.status !== 'succeeded' || !researchResult.message) {
    throw new Error(`research phase failed: ${describeFailure(researchResult)}`);
  }

  return researchResult.message.content;
}
