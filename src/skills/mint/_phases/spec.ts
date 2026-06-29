/**
 * Phase 1: Specification generation.
 * Forks a subagent to draft a detailed specification from the idea.
 */

import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure } from '../../../agent/subagent/result.js';
import { getApiKey } from '../../../cli/shared-helpers.js';
import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import type { AgentModelInput } from '../../../agent/types.js';

export async function runSpecPhase(
  idea: string,
  parentSessionId: string,
  parentCwd?: string,
  // Mint skill's ToolCall id. When present, anchors the forked subagent
  // under the mint skill's tool-lane entry — see runResearchPhase / skills/index.ts.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
): Promise<string> {
  const prompts = loadSkillPrompts('mint');
  const specPrompt = prompts['spec.md'];

  if (!specPrompt) {
    throw new Error('mint skill missing spec.md prompt');
  }

  // `cwd` propagates the parent session's worktree to the forked subagent
  // so its bash/grep run in the right working tree. Without this, two
  // concurrent `afk interactive -w` terminals running /mint would have
  // their spec subagents both spawn against the host's process.cwd().
  const manager = new SubagentManager(
    parentCwd !== undefined ? { cwd: parentCwd } : {},
  );
  const specHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: defaultSubagentModel,
      systemPrompt: specPrompt,
      apiKey: getApiKey(),
    },
    idPrefix: 'mint-spec',
    agentType: 'mint-spec',
    phaseRole: 'read-only',
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  const specResult = await specHandle.runToResult(`Create a detailed specification for: ${idea}`);

  if (specResult.status !== 'succeeded' || !specResult.message) {
    throw new Error(`spec phase failed: ${describeFailure(specResult)}`);
  }

  return specResult.message.content;
}
