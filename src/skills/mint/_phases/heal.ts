/**
 * Phase 7: Heal failures.
 * Dispatches /diagnose on verification failures, capped at 2 iterations.
 * Re-runs verification after applying fixes.
 */

import { getSkill } from '../../index.js';
import type { AgentModelInput, IAgentSession } from '../../../agent/types.js';
import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure } from '../../../agent/subagent/result.js';
import { resolveCredentialForModel } from '../../../agent/auth/credential-resolver.js';
import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import type { VerifyResult } from './verify.js';
import type { BuildResult } from './build.js';
import { runVerifyPhase } from './verify.js';

export async function runHealPhase(
  plan: string,
  buildResults: BuildResult,
  verifyResults: VerifyResult,
  healIterations: number,
  parentSession: IAgentSession,
  // Mint skill's ToolCall id — anchors the heal subagent and the re-run
  // verify subagents under the mint skill's tool-lane entry. See
  // skills/index.ts SkillExecutionContext.callId.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
): Promise<{
  healed: boolean;
  newHealIterations: number;
  newVerifyResults: VerifyResult;
}> {
  // Check if all verifications passed
  if (
    verifyResults.testsPassed &&
    verifyResults.lintPassed &&
    verifyResults.designReviewPassed
  ) {
    return {
      healed: true,
      newHealIterations: healIterations,
      newVerifyResults: verifyResults,
    };
  }

  // Cap at 2 iterations
  if (healIterations >= 2) {
    return {
      healed: false,
      newHealIterations: healIterations,
      newVerifyResults: verifyResults,
    };
  }

  // Diagnose failures
  try {
    const diagnoseSkill = getSkill('diagnose');
    const failureDescription =
      `Verification failures:\n` +
      `Tests: ${verifyResults.testsPassed ? 'PASS' : 'FAIL'}\n` +
      `Lint: ${verifyResults.lintPassed ? 'PASS' : 'FAIL'}\n` +
      `Design: ${verifyResults.designReviewPassed ? 'PASS' : 'FAIL'}\n` +
      `Issues: ${verifyResults.issues?.join('\n') || 'none'}`;

    const diagnosis = await diagnoseSkill.handler({
      failure: failureDescription,
      // Honor the session's worktree (e.g. afk interactive -w). Falls
      // back to process.cwd() only when no worktree is configured.
      repoPath: parentSession.cwd ?? process.cwd(),
      context: plan,
    });

    // Extract proposed fix from diagnosis
    let proposedFix = '';
    if (
      typeof diagnosis === 'object' &&
      diagnosis !== null &&
      'winner' in diagnosis &&
      typeof diagnosis.winner === 'object' &&
      diagnosis.winner !== null
    ) {
      const winner = diagnosis.winner as Record<string, unknown>;
      if (typeof winner['proposed_fix'] === 'string') {
        proposedFix = winner['proposed_fix'];
      }
    }

    // Apply fix via heal subagent
    const prompts = loadSkillPrompts('mint');
    const healPrompt = prompts['heal.md'];

    if (!healPrompt) {
      throw new Error('mint skill missing heal.md prompt');
    }

    // Propagate parent worktree — heal subagent applies file edits
    // and re-runs tests; must operate on the right working tree.
    const manager = new SubagentManager(
      parentSession.cwd !== undefined ? { cwd: parentSession.cwd } : {},
    );
    const healHandle = await manager.forkSubagent({
      parent: { sessionId: parentSession.sessionId },
      config: {
        model: defaultSubagentModel,
        systemPrompt: healPrompt,
        apiKey: resolveCredentialForModel(defaultSubagentModel),
      },
      idPrefix: 'mint-heal',
      agentType: 'mint-heal',
      ...(skillCallId ? { parentId: skillCallId } : {}),
    });

    const issuesList: string = verifyResults.issues?.join('\n') ?? 'none';
    const healInput =
      `Plan:\n${plan}\n\n` +
      `Proposed fix from diagnosis:\n${proposedFix}\n\n` +
      `Verification issues:\n${issuesList}\n\n` +
      `Apply the fix and update the implementation.`;

    const healResult = await healHandle.runToResult(healInput);

    if (healResult.status !== 'succeeded' || !healResult.message) {
      throw new Error(`heal phase failed: ${describeFailure(healResult)}`);
    }

    // The heal prompt requires a `FIX_APPLIED: true|false` marker on the first
    // line. Missing/malformed marker → treat as `false` (conservative — assume
    // no fix landed if heal didn't tell us). When false, skip the immediate
    // re-verify since failures will persist with the same input.
    const fixApplied =
      /^\s*FIX_APPLIED:\s*(true|false)/im
        .exec(healResult.message.content)?.[1]
        ?.toLowerCase() === 'true';

    const newHealIterations = healIterations + 1;

    if (!fixApplied) {
      return {
        healed: false,
        newHealIterations,
        newVerifyResults: verifyResults,
      };
    }

    if (!parentSession.sessionId) {
      throw new Error('Parent session ID required for verification');
    }
    const newVerifyResults = await runVerifyPhase(
      plan,
      buildResults,
      parentSession.sessionId,
      parentSession.cwd,
      skillCallId,
      defaultSubagentModel,
    );

    return {
      healed:
        newVerifyResults.testsPassed &&
        newVerifyResults.lintPassed &&
        newVerifyResults.designReviewPassed,
      newHealIterations,
      newVerifyResults,
    };
  } catch (err) {
    // If diagnose fails, increment iterations and return failure
    return {
      healed: false,
      newHealIterations: healIterations + 1,
      newVerifyResults: verifyResults,
    };
  }
}
