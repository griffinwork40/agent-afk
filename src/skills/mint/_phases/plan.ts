/**
 * Phase 3: Implementation planning.
 * Forks a subagent to create a detailed implementation plan.
 */

import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure } from '../../../agent/subagent/result.js';
import { getApiKey } from '../../../cli/shared-helpers.js';
import { loadSkillPrompts } from '../../_lib/prompt-loader.js';

export async function runPlanPhase(
  spec: string,
  research: string,
  parentSessionId: string,
  parentCwd?: string,
  // Mint skill's ToolCall id — anchors the forked subagent under the mint
  // skill's tool-lane entry. See skills/index.ts SkillExecutionContext.callId.
  skillCallId?: string,
): Promise<string> {
  const prompts = loadSkillPrompts('mint');
  const planPrompt = prompts['plan.md'];

  if (!planPrompt) {
    throw new Error('mint skill missing plan.md prompt');
  }

  // Propagate parent worktree to subagent — see spec.ts for rationale.
  const manager = new SubagentManager(
    parentCwd !== undefined ? { cwd: parentCwd } : {},
  );
  const planHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: 'sonnet',
      systemPrompt: planPrompt,
      apiKey: getApiKey(),
    },
    idPrefix: 'mint-plan',
    phaseRole: 'read-only',
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  const planInput =
    `Specification:\n${spec}\n\nResearch findings:\n${research}\n\n` +
    `Create a detailed implementation plan based on the spec and research.`;

  const planResult = await planHandle.runToResult(planInput);

  if (planResult.status !== 'succeeded' || !planResult.message) {
    throw new Error(`plan phase failed: ${describeFailure(planResult)}`);
  }

  return planResult.message.content;
}
