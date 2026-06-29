/**
 * Orchestrator phase for the /diagnose skill.
 *
 * Contains the main handler entry point and all phase helpers:
 * - Phase 1: Triage (delegates to triage.ts)
 * - Phase 2: Parallel research (codebase + git)
 * - Phase 3: Hypothesis synthesis
 * - Phase 3.5: Confidence-gated auto-verify (delegates to verifier.ts)
 * - Phase 4: Worktree hypothesis testing
 * - Phase 5: Winner selection
 * - Phase 6: Outcome routing
 *
 * @module skills/diagnose/_phases/orchestrator
 */

import { z } from 'zod';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillPrompts } from '../../_lib/prompt-loader.js';
import type { SkillExecutionContext } from '../../index.js';
import { SubagentManager } from '../../../agent/subagent.js';
import type { SubagentHandle } from '../../../agent/subagent/handle.js';
import { runWave } from '../../../agent/subagent/wave.js';
import { describeFailure } from '../../../agent/subagent/result.js';
import type { AgentModelInput, IAgentSession } from '../../../agent/types.js';
import type { CanUseTool } from '../../../agent/types/sdk-types.js';
import { researchAgent } from '../../_agents/research-agent.js';
import { gitInvestigator } from '../../_agents/git-investigator.js';
import { toAgentDefinition } from '../../_agents/to-definition.js';
import type {
  DiagnosisResult,
  Hypothesis,
  VerificationResult,
  BaselineResult,
} from './types.js';
import { HypothesisSchema, VerificationResultSchema } from './types.js';
import { classifyAndExtract, fixSpansMultipleFiles, computeOutcome } from './triage.js';
import {
  runReproducerBaseline,
  buildVerifierUserPrompt,
  autoVerifyHypotheses,
  parseShadowVerifyOutput,
} from './verifier.js';

const execFile = promisify(execFileCallback);

// ---------------------------------------------------------------------------
// Tool-permission helpers
// ---------------------------------------------------------------------------

/**
 * Create a restrictive canUseTool that only allows read-only tools.
 */
function createReadOnlyCanUseTool(): CanUseTool {
  return async (toolName: string) => {
    if (!researchAgent.allowedTools.includes(toolName as never)) {
      return {
        behavior: 'deny',
        message: `Tool ${toolName} not allowed. Allowed tools: ${researchAgent.allowedTools.join(', ')}`,
      };
    }
    return { behavior: 'allow' };
  };
}

// Orchestrator allowlist — research-agent's read-only base plus Agent for
// dispatching git-investigator via the SDK's built-in Agent tool. Paired with
// an `agents: { 'git-investigator': ... }` registry on the same fork config.
const GIT_ORCHESTRATOR_ALLOWED_TOOLS = [...researchAgent.allowedTools, 'Agent'] as const;

/**
 * Create a canUseTool for the git-orchestrator subagent.
 */
function createGitOrchestratorCanUseTool(): CanUseTool {
  return async (toolName: string) => {
    if (!GIT_ORCHESTRATOR_ALLOWED_TOOLS.includes(toolName as never)) {
      return {
        behavior: 'deny',
        message: `Tool ${toolName} not allowed for git orchestrator. Allowed tools: ${GIT_ORCHESTRATOR_ALLOWED_TOOLS.join(', ')}`,
      };
    }
    return { behavior: 'allow' };
  };
}

/**
 * Create a canUseTool that allows only reading (no Edit, Write, Bash, commit).
 */
function createVerifierCanUseTool(): CanUseTool {
  const deniedTools = ['Edit', 'Write', 'Bash', 'Agent', 'Task'];

  return async (toolName: string) => {
    if (deniedTools.includes(toolName)) {
      return {
        behavior: 'deny',
        message: `Tool ${toolName} not allowed in worktree verification. Verification is read-only.`,
      };
    }
    if (!researchAgent.allowedTools.includes(toolName as never)) {
      return {
        behavior: 'deny',
        message: `Tool ${toolName} not allowed. Allowed tools: ${researchAgent.allowedTools.join(', ')}`,
      };
    }
    return { behavior: 'allow' };
  };
}

// ---------------------------------------------------------------------------
// Reproducer detection
// ---------------------------------------------------------------------------

/**
 * Detect if a reproducer is mentioned in the context.
 */
function detectReproducer(context: string): string | undefined {
  if (!context) return undefined;
  // Simple heuristic: look for markers like "test:", "command:", "npm test", etc.
  const markers = [
    /test:\s*(.+)/i,
    /command:\s*(.+)/i,
    /reproducer:\s*(.+)/i,
    /failing test:\s*(.+)/i,
  ];

  for (const marker of markers) {
    const match = context.match(marker);
    if (match) return match[1];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Worktree hypothesis testing (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Test a single hypothesis in an isolated worktree.
 *
 * Creates a temporary worktree, applies the proposed fix, runs verification,
 * then cleans up. Uses execFile to manage git worktree lifecycle.
 */
async function testHypothesisInWorktree(
  hypothesis: Hypothesis,
  reproducer: string,
  repoPath: string,
  parentSessionId: string,
  verifyPrompt: string,
  manager: SubagentManager,
  // Tool-use ID of the `skill` ToolCall that invoked the diagnose handler.
  // When present, used as `parentId` on the verifier fork so the live overlay
  // and the eventual committed scrollback block nest under the skill node
  // rather than orphaning at root. Optional — `undefined` preserves legacy
  // (raw session UUID → render-at-root) behavior.
  skillCallId?: string,
  baseline?: BaselineResult,
  subagentModel: AgentModelInput = 'sonnet',
): Promise<VerificationResult> {
  const worktreePath = join(tmpdir(), `diagnose-hyp-${hypothesis.id}-${Date.now()}`);
  let verifierHandle: SubagentHandle<VerificationResult> | undefined;

  try {
    // Create isolated worktree
    await execFile('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: repoPath,
    });

    // Write .afk-worktree-meta.json for the sweep engine (best-effort)
    try {
      const { writeFile: wf } = await import('node:fs/promises');
      let diagBaseSha = '';
      let diagBaseBranch = '';
      try {
        const r = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
        diagBaseSha = r.stdout.trim();
      } catch { /* non-fatal */ }
      try {
        const r = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath });
        diagBaseBranch = r.stdout.trim();
      } catch { /* non-fatal */ }
      await wf(
        join(worktreePath, '.afk-worktree-meta.json'),
        JSON.stringify({ owner: 'diagnose', createdAt: new Date().toISOString(), baseSha: diagBaseSha, baseBranch: diagBaseBranch }, null, 2),
        'utf-8',
      );
    } catch { /* best-effort */ }

    // Fork verifier subagent with restricted tools
    verifierHandle = await manager.forkSubagent({
      parent: { sessionId: parentSessionId },
      config: {
        model: subagentModel,
        systemPrompt: `${verifyPrompt}\n\nYou are testing in an isolated worktree at: ${worktreePath}`,
        canUseTool: createVerifierCanUseTool(),
      },
      idPrefix: `diagnose-verifier-${hypothesis.id}`,
      outputSchema: VerificationResultSchema,
      ...(skillCallId ? { parentId: skillCallId } : {}),
    });

    const effectiveBaseline: BaselineResult = baseline ?? {
      skipped: true,
      reason: 'baseline not computed',
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    };
    const userPrompt = buildVerifierUserPrompt(hypothesis, reproducer, worktreePath, effectiveBaseline);

    const verificationResult = await verifierHandle.runToResult(userPrompt);

    if (verificationResult.status !== 'succeeded' || !verificationResult.output) {
      return {
        hypothesis_id: hypothesis.id,
        predicted_pass: false,
        regressions: [],
        confidence: 0,
        verification_log: `Verification failed: ${describeFailure(verificationResult)}`,
      };
    }

    return verificationResult.output;
  } catch (error) {
    return {
      hypothesis_id: hypothesis.id,
      predicted_pass: false,
      regressions: [],
      confidence: 0,
      verification_log: `Error during verification: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    // Tear down the verifier handle (fires SubagentStop with the real
    // terminal status) before the worktree cleanup — subagent state first,
    // filesystem second.
    if (verifierHandle) {
      try {
        await verifierHandle.teardown();
      } catch {
        // best-effort — dispatch errors are swallowed inside teardown()
      }
    }
    // Clean up worktree
    try {
      await execFile('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: repoPath,
      });
    } catch (cleanupError) {
      // Silently ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handler for the /diagnose skill.
 *
 * @param input - Must have `failure` (string) and `repoPath` (string);
 *                optional `context` (string) and `maxHypotheses` (number, capped at 4)
 * @param parentSession - Parent agent session (used to fork subagents)
 * @returns Parsed DiagnosisResult with hypotheses and optional winner
 */
export async function handler(
  input: unknown,
  parentSession?: IAgentSession,
  ctx?: SkillExecutionContext,
): Promise<DiagnosisResult> {
  const apiKey = ctx?.apiKey;
  const subagentModel = ctx?.defaultSubagentModel ?? ctx?.defaultModel ?? 'sonnet';
  // Parse input — accept both structured object and plain string (from slash commands)
  const parsedInput = (() => {
    if (typeof input === 'string') {
      return {
        failure: input,
        repoPath: process.cwd(),
        context: '',
        maxHypotheses: 4,
      };
    }
    if (typeof input === 'object' && input !== null) {
      const inputObj = input as Record<string, unknown>;
      if (typeof inputObj['failure'] === 'string') {
        return {
          failure: inputObj['failure'] as string,
          repoPath: (inputObj['repoPath'] as string | undefined) || process.cwd(),
          context: (inputObj['context'] as string | undefined) || '',
          maxHypotheses: Math.min(
            (inputObj['maxHypotheses'] as number | undefined) || 4,
            4, // Hard cap at 4
          ),
        };
      }
    }
    throw new Error(
      'diagnose handler requires input.failure (string) or a string argument',
    );
  })();

  if (!parentSession?.sessionId) {
    throw new Error('diagnose requires a parent session with sessionId');
  }

  const parentSessionId = parentSession.sessionId;

  // Load prompts
  const prompts = loadSkillPrompts('diagnose');
  const systemPrompt = prompts['system.md'];
  const researchPrompt = prompts['research.md'];
  const hypothesisPrompt = prompts['hypothesis.md'];
  const verifyPrompt = prompts['verify.md'];

  if (!systemPrompt || !researchPrompt || !hypothesisPrompt || !verifyPrompt) {
    throw new Error(
      'diagnose skill missing required prompts (system.md, research.md, hypothesis.md, verify.md)',
    );
  }

  // Forward the parent's witness writer (when ctx supplies one) so the
  // research/git/hypothesis forks below inherit it and their tool activity —
  // notably the read-only `canUseTool` permission-denials these restrictive
  // allowlists produce — lands in the parent trace as hook_decision + tool_call
  // events instead of being lost. See skills/index.ts SkillExecutionContext.traceWriter.
  const manager = new SubagentManager({
    apiKey,
    ...(ctx?.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
  });

  // Phase 1: Triage — reproducer + structured failure classification.
  const reproducer = detectReproducer(parsedInput.context);
  const triage = classifyAndExtract(parsedInput.failure, parsedInput.context);
  const triageBlock =
    `Triage:\n` +
    `  failure_type:    ${triage.failure_type}\n` +
    `  error_signature: ${triage.error_signature}\n` +
    `  affected_area:   ${triage.affected_area}`;

  // Phase 2: Parallel research (codebase + git). Both agents receive the
  // shared triage anchor points so their findings can be cross-referenced
  // in Phase 3 on common axes (location, category, confidence).
  //
  // Lane override: research-agent.md is the shared vendored system prompt
  // (byte-pinned in src/skills/_agents/vendored.test.ts) and tells the agent
  // to dispatch `git-investigator` via the Agent tool on git-flavored
  // signals. The CODEBASE lane mechanically denies Agent (see
  // createReadOnlyCanUseTool below), so those dispatch instructions describe
  // a capability the lane doesn't have. Without an explicit override the
  // agent falls back to reading `.git/` internals directly — which
  // research-agent.md itself flags as a contract violation, and which
  // produces noise like "60 worktrees and 1 stash" when the failure
  // description happens to mention git terms.
  //
  // The override is appended AFTER researchAgent.systemPrompt so it has the
  // last word, and is scoped to the codebase lane only — the git lane has
  // both the Agent tool and the git-investigator registry, so the upstream
  // instructions apply correctly there.
  const codebaseLaneOverride =
    '\n\n## Lane override (codebase research)\n\n' +
    'The Agent tool is not available in this lane. Do not attempt to ' +
    'dispatch `git-investigator` or any other subagent — those calls will ' +
    'be denied. Do not substitute direct reads of `.git/` internals (refs, ' +
    'logs, packed-refs, worktrees, stash entries) for git commands; those ' +
    'are not codebase findings and surfacing them is the documented ' +
    'anti-pattern. Confine investigation to source code paths via Read, ' +
    'Grep, and Glob.';
  const codebaseResearchPrompt = `${researchAgent.systemPrompt}${codebaseLaneOverride}\n\n${researchPrompt}\n\nFocus: CODEBASE\n${triageBlock}\nFailure: ${parsedInput.failure}${parsedInput.context ? `\nContext: ${parsedInput.context}` : ''}`;
  const gitResearchPrompt = `${researchAgent.systemPrompt}\n\n${researchPrompt}\n\nFocus: GIT HISTORY\n${triageBlock}\nFailure: ${parsedInput.failure}${parsedInput.context ? `\nContext: ${parsedInput.context}` : ''}\n\nRepo: ${parsedInput.repoPath}`;

  // `parentId: ctx.callId` (when present) anchors the synthesized `Agent(...)`
  // entry under THIS skill's tool-lane entry in the live overlay AND in the
  // committed scrollback block. Without it the renderer's Path 3 fallback fires
  // (raw session UUID is not a known source / lane entry) and the subagent
  // orphans to root the moment its Done block commits. See
  // stream-renderer.ts:262-280 for the resolver, tool-lane.ts:flushSource for
  // the indent-aware flush, and skills/index.ts SkillExecutionContext.callId
  // for the contract.
  const skillCallId = ctx?.callId;
  const codebaseHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: subagentModel,
      systemPrompt: codebaseResearchPrompt,
      canUseTool: createReadOnlyCanUseTool(),
    },
    idPrefix: 'diagnose-codebase-research',
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  // Restriction to git-investigator comes from the single-entry `agents`
  // registry below — the SDK exposes it via the built-in Agent tool. The
  // `Agent(git-investigator)` syntax in upstream's frontmatter is plugin
  // parser syntax, not SDK syntax; here we set the registry directly.
  const gitHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: subagentModel,
      systemPrompt: gitResearchPrompt,
      cwd: parsedInput.repoPath,
      agents: {
        'git-investigator': {
          ...toAgentDefinition(gitInvestigator),
          model: subagentModel,
        },
      },
      canUseTool: createGitOrchestratorCanUseTool(),
    },
    idPrefix: 'diagnose-git-research',
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  // Run research in parallel via runWave — dispatches SubagentStop per
  // handle and preserves partial results. failFast=false because either
  // research branch failing shouldn't prevent the other from completing.
  const [codebaseResult, gitResult] = await runWave(
    [
      {
        handle: codebaseHandle,
        prompt: 'Analyze the codebase for potential causes of this failure.',
      },
      {
        handle: gitHandle,
        prompt: 'Analyze git history for recent changes that could cause this failure.',
      },
    ],
    { failFast: false },
  );

  // Collect research findings (soft-fail: empty result → 'No output').
  const researchFindings = {
    codebase: codebaseResult?.output || codebaseResult?.message || 'No output',
    git: gitResult?.output || gitResult?.message || 'No output',
  };

  // Phase 3: Synthesize hypotheses
  const hypothesisHandle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model: subagentModel,
      systemPrompt: `${systemPrompt}\n\n${hypothesisPrompt}`,
      canUseTool: createReadOnlyCanUseTool(),
    },
    idPrefix: 'diagnose-hypothesis-synthesis',
    outputSchema: z.object({
      hypotheses: z.array(HypothesisSchema),
    }),
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  const hypothesisUserPrompt = `Given these research findings, synthesize 2–4 hypotheses (max 4):\n\n` +
    `CODEBASE RESEARCH:\n${JSON.stringify(researchFindings.codebase, null, 2)}\n\n` +
    `GIT RESEARCH:\n${JSON.stringify(researchFindings.git, null, 2)}\n\n` +
    `Original failure: ${parsedInput.failure}`;

  let hypothesisResult;
  try {
    hypothesisResult = await hypothesisHandle.runToResult(hypothesisUserPrompt);
  } finally {
    await hypothesisHandle.teardown().catch(() => undefined);
  }

  if (hypothesisResult.status !== 'succeeded' || !hypothesisResult.output) {
    if (hypothesisResult.schemaError) {
      const rawResponse = hypothesisResult.message?.content || '(no response)';
      throw new Error(
        `hypothesis synthesis schema mismatch: ${hypothesisResult.schemaError.message}\n` +
          `  Raw response (first 500 chars): ${rawResponse.slice(0, 500)}\n` +
          `  Hint: model response must include a fenced JSON block with a hypotheses array.`,
      );
    }
    throw new Error(`hypothesis synthesis failed: ${describeFailure(hypothesisResult)}`);
  }

  const hypotheses = hypothesisResult.output.hypotheses.slice(0, parsedInput.maxHypotheses);

  if (hypotheses.length === 0) {
    return {
      reproducer,
      triage,
      hypotheses: [],
      verification_results: [],
      outcome: 'no_hypotheses',
    };
  }

  // Phase 3.5: Confidence-gated auto-verify. Hypotheses with low confidence,
  // declared coverage_gaps, or a boundary_flag get independently re-checked by
  // /shadow-verify before we spend compute testing them in worktrees. Refuted
  // claims are dropped from Phase 4 but stay visible in the result so callers
  // can see what was doubted.
  const { premise_verifications, hypotheses_to_test } = await autoVerifyHypotheses(
    hypotheses,
    async (claims) => {
      // shadow-verify is a bundled plugin skill (SKILL.md only, not in the TS
      // registry), so we route through ctx.dispatchSkill — which uses the same
      // registry → plugin-body lookup as the `skill` tool. Older callers / test
      // stubs without dispatchSkill surface as an autoVerify dispatchError and
      // every gated hypothesis is marked INCONCLUSIVE.
      if (!ctx?.dispatchSkill) {
        throw new Error('shadow-verify dispatch unavailable (no dispatchSkill in ctx)');
      }
      // Contract: shadow-verify is a free-prose skill — its sub-agent returns a
      // human-readable merge summary, NOT a JSON document. So we (a) ask it, via
      // the dispatched context, to append a machine-readable envelope, and (b)
      // parse that envelope defensively. parseShadowVerifyOutput tolerates
      // surrounding prose and THROWS a descriptive error on any miss; the throw
      // is caught by autoVerifyHypotheses, which marks the gated hypotheses
      // INCONCLUSIVE — never dropping them and never crashing. (The previous
      // `JSON.parse(rawOutput)` assumed bare JSON: it threw a SyntaxError on the
      // prose — silently disabling the whole gate — and could crash on
      // valid-but-wrong-shape JSON.)
      const argsJson = JSON.stringify({
        claims,
        context:
          `Original failure: ${parsedInput.failure}\n\n` +
          `OUTPUT CONTRACT (required): after your verification, end your reply ` +
          `with a single fenced \`\`\`json block of exactly this shape — one ` +
          `entry per claim, in the SAME order you received them:\n` +
          `{"verifications":[{"claim":"<echo of the claim>","verdict":"VERIFIED|REFUTED|INCONCLUSIVE","evidence":"<1-2 sentences; cite file:line or source>"}]}`,
      });
      const rawOutput = await ctx.dispatchSkill('shadow-verify', argsJson);
      return parseShadowVerifyOutput(rawOutput);
    },
  );

  if (hypotheses_to_test.length === 0) {
    // All hypotheses were refuted by /shadow-verify before worktree testing.
    // Surface them so the caller sees what was doubted; outcome is
    // `no_hypotheses` because nothing testable survived gating.
    return {
      reproducer,
      triage,
      hypotheses,
      premise_verifications,
      verification_results: [],
      outcome: 'no_hypotheses',
    };
  }

  // Phase 4: Test hypotheses in isolated worktrees
  const reproduceCommand = reproducer || parsedInput.failure;

  // Run the reproducer ONCE at the repo root (which has node_modules) to get
  // a ground-truth baseline BEFORE any worktree is created.  Only run when a
  // real shell command was detected via detectReproducer — never run prose
  // failure descriptions.  The baseline is NON-FATAL: any error degrades to
  // skipped rather than crashing the skill.
  let baseline: BaselineResult;
  if (reproducer) {
    try {
      baseline = await runReproducerBaseline(reproducer, parsedInput.repoPath);
    } catch (baselineErr) {
      baseline = {
        skipped: true,
        reason: `baseline execution error: ${baselineErr instanceof Error ? baselineErr.message : String(baselineErr)}`,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
      };
    }
  } else {
    baseline = {
      skipped: true,
      reason: 'no reproducer command detected',
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    };
  }

  const verificationPromises = hypotheses_to_test.map((hypothesis) =>
    testHypothesisInWorktree(
      hypothesis,
      reproduceCommand,
      parsedInput.repoPath,
      parentSessionId,
      verifyPrompt,
      manager,
      skillCallId,
      baseline,
      subagentModel,
    ),
  );

  const verificationResults = await Promise.all(verificationPromises);

  // Phase 5: Select winner. Among hypotheses whose predicted_pass is true with
  // no regressions, take the highest-confidence one (tiebreak); fall back
  // to any predicted_pass result so we preserve the prior behavior of
  // surfacing a winner even when regressions exist. Sort is stable, so
  // ties between equal-confidence results resolve to the earlier hypothesis.
  const cleanPasses = verificationResults
    .filter((r) => r.predicted_pass && r.regressions.length === 0)
    .slice()
    .sort((a, b) => b.confidence - a.confidence);
  const winner =
    cleanPasses[0] ?? verificationResults.find((r) => r.predicted_pass);

  // Phase 6: Compute named outcome and the advisory next-skill recommendation.
  const outcome = computeOutcome(hypotheses, verificationResults);
  const winnerHypothesis = winner
    ? hypotheses.find((h) => h.id === winner.hypothesis_id)
    : undefined;
  const recommended_next_skill: 'spec' | undefined =
    outcome === 'clear_winner' && winnerHypothesis && fixSpansMultipleFiles(winnerHypothesis)
      ? 'spec'
      : undefined;

  return {
    reproducer,
    triage,
    hypotheses,
    premise_verifications:
      premise_verifications.length > 0 ? premise_verifications : undefined,
    winner: winner
      ? {
          hypothesis_id: winner.hypothesis_id,
          verification_log: winner.verification_log,
          proposed_fix: winnerHypothesis?.proposed_fix || '',
        }
      : undefined,
    verification_results: verificationResults,
    outcome,
    recommended_next_skill,
  };
}
