/**
 * Phase 5: Build implementation.
 * Forks a subagent to execute the implementation plan.
 */

import { z } from 'zod';
import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure } from '../../../agent/subagent/result.js';
import { getApiKey } from '../../../cli/shared-helpers.js';
import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import type { AgentModelInput } from '../../../agent/types.js';
import { emitCard } from '../../_lib/emit-card.js';

const BuildOutputSchema = z.object({
  status: z.enum(['PASS', 'FAIL']),
  status_reason: z.string().optional(),
  files_changed: z.array(z.string()),
  tests_passed: z.boolean(),
  build_passed: z.boolean().optional(),
  verification_passed: z.boolean().optional(),
  notes: z.string(),
});

export interface BuildResult {
  filesChanged: string[];
  testsPassed: boolean;
  notes: string;
}

export async function runBuildPhase(
  plan: string,
  orchestrationPlan: unknown,
  parentSessionId: string,
  parentCwd?: string,
  // Mint skill's ToolCall id — anchors the forked subagent under the mint
  // skill's tool-lane entry. See skills/index.ts SkillExecutionContext.callId.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
): Promise<BuildResult> {
  const prompts = loadSkillPrompts('mint');
  const buildPrompt = prompts['build.md'];

  if (!buildPrompt) {
    throw new Error('mint skill missing build.md prompt');
  }

  // Propagate parent worktree to the build subagent so its bash/grep
  // run in the right working tree — critical here because build is the
  // phase that actually mutates files and runs git commands.
  const manager = new SubagentManager(
    parentCwd !== undefined ? { cwd: parentCwd } : {},
  );
  const buildHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: defaultSubagentModel,
      systemPrompt: buildPrompt,
      apiKey: getApiKey(),
    },
    idPrefix: 'mint-build',
    agentType: 'mint-build',
    outputSchema: BuildOutputSchema,
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  const buildInput =
    `Implementation plan:\n${plan}\n\n` +
    (orchestrationPlan
      ? `Wave orchestration plan:\n${JSON.stringify(orchestrationPlan, null, 2)}\n\n`
      : '') +
    `Execute the implementation plan following TDD (test-first) principles.`;

  const buildResult = await buildHandle.runToResult(buildInput);

  if (buildResult.status !== 'succeeded' || !buildResult.output) {
    throw new Error(`build phase failed: ${describeFailure(buildResult)}`);
  }

  const output = buildResult.output;
  const result: BuildResult = {
    filesChanged: output.files_changed,
    testsPassed: output.tests_passed,
    notes: output.notes,
  };

  emitCard({
    kind: 'checkpoint',
    title: 'build',
    body: [
      `Files changed: ${result.filesChanged.length}`,
      `Tests: ${result.testsPassed ? 'passed' : 'failed'}`,
      `Next: verify`,
    ],
  });

  return result;
}
