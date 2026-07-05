/**
 * Phase 6: Verify with parallel test, lint, and design-review.
 * Forks three subagents in parallel to test, lint, and review design.
 */

import { z } from 'zod';
import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure } from '../../../agent/subagent/result.js';
import { resolveCredentialForModel } from '../../../agent/auth/credential-resolver.js';
import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import { emitCard } from '../../_lib/emit-card.js';
import type { BuildResult } from './build.js';
import type { AgentModelInput } from '../../../agent/types.js';

const VerifyModeOutputSchema = z.object({
  status: z.enum(['PASS', 'FAIL']),
  status_reason: z.string().optional(),
  issues: z.array(z.string()).default([]),
  summary: z.string().optional(),
});

export interface VerifyResult {
  testsPassed: boolean;
  lintPassed: boolean;
  designReviewPassed: boolean;
  issues?: string[];
}

async function forkVerifyMode(
  mode: 'test' | 'lint' | 'design-review',
  plan: string,
  buildResults: BuildResult,
  parentSessionId: string,
  verifyPrompt: string,
  parentCwd?: string,
  // Mint skill's ToolCall id — anchors the parallel verify-mode subagent
  // under the mint skill's tool-lane entry. See skills/index.ts SkillExecutionContext.callId.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
): Promise<{ passed: boolean; issues?: string[] }> {
  // Propagate parent worktree — verify subagents run tests/lint/grep in
  // the right working tree.
  const manager = new SubagentManager(
    parentCwd !== undefined ? { cwd: parentCwd } : {},
  );
  const verifyHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: defaultSubagentModel,
      systemPrompt: verifyPrompt,
      apiKey: resolveCredentialForModel(defaultSubagentModel),
    },
    idPrefix: `mint-verify-${mode}`,
    agentType: `mint-verify-${mode}`,
    outputSchema: VerifyModeOutputSchema,
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  const verifyInput =
    `Plan:\n${plan}\n\n` +
    `Build results:\n${JSON.stringify(buildResults, null, 2)}\n\n` +
    `Mode: ${mode}\n\n` +
    `Run ${mode} verification on the implementation.`;

  let verifyResult;
  try {
    verifyResult = await verifyHandle.runToResult(verifyInput);
  } finally {
    // Dispatch SubagentStop regardless of run outcome.
    await verifyHandle.teardown().catch(() => undefined);
  }

  // Soft-fail per mode: any runtime error or schema-parse failure surfaces as
  // FAIL with the failure cause in `issues`. Verify failures are first-class
  // signal that drives the heal loop, not exceptions.
  if (verifyResult.status !== 'succeeded' || !verifyResult.output) {
    return {
      passed: false,
      issues: [`${mode} verification failed: ${describeFailure(verifyResult)}`],
    };
  }

  const output = verifyResult.output;
  const passed = output.status === 'PASS';
  return {
    passed,
    issues: passed ? undefined : output.issues,
  };
}

export async function runVerifyPhase(
  plan: string,
  buildResults: BuildResult,
  parentSessionId: string,
  parentCwd?: string,
  // Mint skill's ToolCall id — anchors every parallel verify-mode subagent
  // under the mint skill's tool-lane entry. See skills/index.ts SkillExecutionContext.callId.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
): Promise<VerifyResult> {
  const prompts = loadSkillPrompts('mint');
  const verifyPrompt = prompts['verify.md'];

  if (!verifyPrompt) {
    throw new Error('mint skill missing verify.md prompt');
  }

  // Run test, lint, and design-review in parallel
  const [testResult, lintResult, designResult] = await Promise.all([
    forkVerifyMode('test', plan, buildResults, parentSessionId, verifyPrompt, parentCwd, skillCallId, defaultSubagentModel),
    forkVerifyMode('lint', plan, buildResults, parentSessionId, verifyPrompt, parentCwd, skillCallId, defaultSubagentModel),
    forkVerifyMode('design-review', plan, buildResults, parentSessionId, verifyPrompt, parentCwd, skillCallId, defaultSubagentModel),
  ]);

  const allIssues: string[] = [];
  if (testResult.issues) allIssues.push(...testResult.issues);
  if (lintResult.issues) allIssues.push(...lintResult.issues);
  if (designResult.issues) allIssues.push(...designResult.issues);

  const result: VerifyResult = {
    testsPassed: testResult.passed,
    lintPassed: lintResult.passed,
    designReviewPassed: designResult.passed,
    ...(allIssues.length > 0 ? { issues: allIssues } : {}),
  };

  const allPassed =
    result.testsPassed && result.lintPassed && result.designReviewPassed;
  const flag = (ok: boolean): string => (ok ? 'passed' : 'failed');

  emitCard({
    kind: allPassed ? 'checkpoint' : 'diagnosis',
    title: 'verify',
    body: [
      `Tests: ${flag(result.testsPassed)} · Lint: ${flag(result.lintPassed)}`,
      `Design review: ${flag(result.designReviewPassed)}`,
      ...(allPassed
        ? ['Next: ship']
        : [`Issues: ${allIssues.length} (heal loop will retry)`]),
    ],
  });

  return result;
}
