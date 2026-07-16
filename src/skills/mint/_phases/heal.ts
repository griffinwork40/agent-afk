/**
 * Phase 7: Heal failures.
 * Dispatches /diagnose on verification failures, capped at 2 iterations.
 * Re-runs verification after applying fixes.
 */

import type { AgentModelInput, IAgentSession } from '../../../agent/types.js';
import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure, isIncompleteStopReason } from '../../../agent/subagent/result.js';
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
  // Dispatches the agent-driven `/diagnose` skill (bundled plugin SKILL.md,
  // context: fork) and returns its prose root-cause report. Threaded from the
  // mint handler's SkillExecutionContext (`ctx.dispatchSkill`). Optional so
  // callers/tests without a skill-dispatch context degrade gracefully — the
  // heal sub-agent then diagnoses the failures itself from the issue list.
  dispatchSkill?: (name: string, args?: string) => Promise<string>,
  // Read-scope inheritance (#547): parent session's read roots (resolved once
  // by the mint handler); seeds the heal fork manager's parentReadRoots and is
  // forwarded to the re-run verify phase so both inherit reads ⊇ the parent
  // session's. Undefined leaves cwd-derivation intact.
  parentReadRoots?: string[],
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

  // Diagnose failures via the agent-driven `/diagnose` skill. The vendored TS
  // diagnose orchestrator was retired in favor of the bundled-plugin SKILL.md
  // (context: fork): dispatchSkill forks a diagnose sub-agent that runs the
  // parallel-hypothesis root-cause analysis and returns a prose report, which
  // the heal sub-agent below reads and acts on — no structured-output coupling.
  try {
    const failureDescription =
      `Verification failures:\n` +
      `Tests: ${verifyResults.testsPassed ? 'PASS' : 'FAIL'}\n` +
      `Lint: ${verifyResults.lintPassed ? 'PASS' : 'FAIL'}\n` +
      `Design: ${verifyResults.designReviewPassed ? 'PASS' : 'FAIL'}\n` +
      `Issues: ${verifyResults.issues?.join('\n') || 'none'}`;

    // The forked diagnose inherits the parent's worktree cwd (anchored by the
    // skill executor), so it inspects the same tree the heal sub-agent edits.
    const diagnosisReport = dispatchSkill
      ? await dispatchSkill(
          'diagnose',
          `${failureDescription}\n\nContext (implementation plan):\n${plan}`,
        )
      : '';

    // Apply fix via heal subagent
    const prompts = loadSkillPrompts('mint');
    const healPrompt = prompts['heal.md'];

    if (!healPrompt) {
      throw new Error('mint skill missing heal.md prompt');
    }

    // Propagate parent worktree — heal subagent applies file edits
    // and re-runs tests; must operate on the right working tree.
    const manager = new SubagentManager({
      ...(parentSession.cwd !== undefined ? { cwd: parentSession.cwd } : {}),
      ...(parentReadRoots !== undefined ? { parentReadRoots } : {}),
    });
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
      `Failure diagnosis (from /diagnose):\n` +
      `${diagnosisReport || '(diagnosis unavailable — diagnose the failures yourself from the verification issues below)'}\n\n` +
      `Verification issues:\n${issuesList}\n\n` +
      `Apply the fix and update the implementation.`;

    const healResult = await healHandle.runToResult(healInput);

    if (healResult.status !== 'succeeded' || !healResult.message) {
      throw new Error(`heal phase failed: ${describeFailure(healResult)}`);
    }
    // A `succeeded` result can still be an incomplete partial — the tool-use cap
    // fired or the stream closed without a terminal message. Its `.message.content`
    // is a truncated placeholder, so the `FIX_APPLIED:` marker below cannot be
    // trusted; hard-fail (the surrounding catch counts this as a non-healed
    // iteration) rather than reading a partial as if a fix had landed.
    if (isIncompleteStopReason(healResult.stopReason)) {
      throw new Error(
        `heal phase returned an incomplete result (stopReason=${healResult.stopReason})`,
      );
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
      parentReadRoots,
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
