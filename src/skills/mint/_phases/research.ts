/**
 * Phase 2: Research context gathering.
 * Forks a subagent to gather codebase and architectural context.
 */

import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure, isIncompleteStopReason } from '../../../agent/subagent/result.js';
import { resolveCredentialForModel } from '../../../agent/auth/credential-resolver.js';
import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
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

  // Propagate parent worktree to subagent — see spec.ts for rationale.
  const manager = new SubagentManager({
    ...(parentCwd !== undefined ? { cwd: parentCwd } : {}),
    ...(parentReadRoots !== undefined ? { parentReadRoots } : {}),
    ...(traceWriter !== undefined ? { traceWriter } : {}),
    ...(workspaceStore !== undefined ? { workspaceStore } : {}),
  });
  const researchHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: defaultSubagentModel,
      systemPrompt: researchPrompt,
      apiKey: resolveCredentialForModel(defaultSubagentModel),
    },
    idPrefix: 'mint-research',
    agentType: 'mint-research',
    phaseRole: 'read-only',
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  const researchResult = await researchHandle.runToResult(
    `Gather context and research for this specification:\n\n${spec}`,
  );

  if (researchResult.status !== 'succeeded' || !researchResult.message) {
    throw new Error(`research phase failed: ${describeFailure(researchResult)}`);
  }
  // A `succeeded` result can still be an incomplete partial — the tool-use cap
  // fired or the stream closed without a terminal message. Its `.message.content`
  // is a truncated placeholder, not real research; the phase output feeds the
  // next phase programmatically, so hard-fail rather than forward a partial.
  if (isIncompleteStopReason(researchResult.stopReason)) {
    throw new Error(
      `research phase returned an incomplete result (stopReason=${researchResult.stopReason})`,
    );
  }

  return researchResult.message.content;
}
