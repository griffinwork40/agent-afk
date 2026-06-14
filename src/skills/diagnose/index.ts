/**
 * /diagnose skill — parallel root-cause analysis for bugs and failing tests.
 *
 * When a test fails or bug is reported:
 * 1. Ensure a reproducer exists (failing test or verification command)
 * 2. Fork parallel research subagents (codebase + git analysis)
 * 3. Synthesize 2–4 hypotheses from findings (HARD CAP at 4)
 * 4. Test each hypothesis in an isolated git worktree
 * 5. Report the validated root cause and proposed fix
 *
 * Each hypothesis tester runs in its own worktree with read-only enforcement
 * via canUseTool (no Edit/Write/Bash/commit).
 *
 * @module skills/diagnose
 */

import { z } from 'zod';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { loadSkillPrompts } from '../_lib/prompt-loader.js';
import { shouldAutoVerify } from '../_lib/confidence-gate.js';
import { registerSkill, type SkillExecutionContext, type SkillMetadata } from '../index.js';
import { SubagentManager } from '../../agent/subagent.js';
import type { SubagentHandle } from '../../agent/subagent/handle.js';
import { runWave } from '../../agent/subagent/wave.js';
import { describeFailure } from '../../agent/subagent/result.js';
import type { AgentModelInput, IAgentSession } from '../../agent/types.js';
import type { CanUseTool } from '../../agent/types/sdk-types.js';
import { researchAgent } from '../_agents/research-agent.js';
import { gitInvestigator } from '../_agents/git-investigator.js';
import { toAgentDefinition } from '../_agents/to-definition.js';
export interface Verification {
  claim: string;
  verdict: 'VERIFIED' | 'REFUTED' | 'INCONCLUSIVE';
  evidence: string;
}

/**
 * Normalize a free-text verdict token into diagnose's premise-gate enum.
 * shadow-verify verifiers speak in confirm/disagree terms; the gate needs
 * VERIFIED | REFUTED | INCONCLUSIVE. Unrecognized tokens degrade to
 * INCONCLUSIVE (safe — the hypothesis stays in play for worktree testing).
 */
function normalizeVerdict(token: string): Verification['verdict'] {
  const t = token.trim().toUpperCase();
  if (['VERIFIED', 'CONFIRMED', 'CONFIRM', 'SUPPORTED', 'TRUE', 'PASS', 'PASSED'].includes(t)) {
    return 'VERIFIED';
  }
  if (
    [
      'REFUTED',
      'REFUTE',
      'DISAGREE',
      'DISAGREED',
      'CONTRADICTED',
      'FALSE',
      'FAIL',
      'FAILED',
    ].includes(t)
  ) {
    return 'REFUTED';
  }
  return 'INCONCLUSIVE';
}

/**
 * Tolerant shape for the verification envelope diagnose asks shadow-verify to
 * append. Only `verdict` is required; `claim`/`evidence` are optional because
 * the prose skill is merely *asked* to follow the contract — we backfill
 * defaults rather than reject a near-miss.
 */
const ShadowVerifyEnvelopeSchema = z.object({
  verifications: z.array(
    z.object({
      claim: z.string().optional(),
      verdict: z.string(),
      evidence: z.string().optional(),
    }),
  ),
});

/**
 * Return every top-level brace-balanced `{...}` span in `text`, in order.
 * String- and escape-aware so braces inside JSON string values don't unbalance
 * the scan. Used to recover a JSON object embedded in free-form prose (a fenced
 * code block, inline, or surrounded by narrative).
 */
function findBalancedObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          spans.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return spans;
}

/**
 * Parse the raw text returned by dispatching the `shadow-verify` skill into a
 * typed {@link Verification}[]. shadow-verify is a markdown SKILL.md plugin
 * skill, so `dispatchSkill` returns the verifier sub-agent's FREE-FORM final
 * message — not a bare JSON string. This parser tolerantly recovers the JSON
 * envelope from surrounding prose (fenced block / inline / narrative),
 * validates it, normalizes the verdict vocabulary, and backfills optional
 * fields. It THROWS a descriptive Error when no `{ verifications: [...] }`
 * envelope can be recovered, so the caller ({@link autoVerifyHypotheses}) marks
 * the gated hypotheses INCONCLUSIVE with a clear reason instead of crashing or
 * mislabeling the failure as a dispatch/network error.
 *
 * @throws Error when no parseable verification envelope is present.
 */
export function parseShadowVerifyOutput(raw: string): Verification[] {
  const candidates = findBalancedObjects(raw);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = ShadowVerifyEnvelopeSchema.safeParse(parsed);
    if (result.success) {
      return result.data.verifications.map((v) => ({
        claim: v.claim ?? '',
        verdict: normalizeVerdict(v.verdict),
        evidence: v.evidence ?? '',
      }));
    }
  }
  throw new Error(
    `shadow-verify did not return a parseable {"verifications":[...]} envelope ` +
      `(${candidates.length} JSON-like span(s) found, none matched the schema); ` +
      `raw output (first 300 chars): ${raw.slice(0, 300)}`,
  );
}

const execFile = promisify(execFileCallback);

// ---------------------------------------------------------------------------
// Baseline reproducer execution
// ---------------------------------------------------------------------------

/**
 * The result of running the reproducer command ONCE on the current/unfixed
 * code at the repo root — before any worktree is created.
 */
export interface BaselineResult {
  skipped: boolean;
  reason?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Truncate a string to its LAST `maxLen` characters, prefixing with a marker
 * when truncation occurred.  Test failures surface at the end of output.
 */
function tailTruncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `...[truncated]\n${s.slice(s.length - maxLen)}`;
}

/**
 * Run the detected reproducer command ONCE on the current/unfixed code and
 * return the measured result as ground truth for the verifier.
 *
 * @param command  The raw shell command string extracted by detectReproducer.
 * @param cwd      MUST be parsedInput.repoPath (the real repo root, which has
 *                 node_modules). Worktrees lack gitignored deps.
 * @param exec     Injectable execFile shim — defaults to the module-level
 *                 promisified execFile so tests can fake it without spawning
 *                 real processes.
 *
 * // Invariant: The parent (orchestrator TS code) executes the SINGLE detected
 * // reproducer command — NOT a model-chosen command — directly at the repo
 * // root. This is bounded and faithful to what the developer would run by
 * // hand, but a true execution sandbox (container / network-egress isolation)
 * // is tracked as a separate follow-up. The kill switch
 * // AFK_DIAGNOSE_BASELINE=0 disables execution entirely for environments
 * // where running untrusted commands at session time is unacceptable.
 */
export async function runReproducerBaseline(
  command: string,
  cwd: string,
  exec: typeof execFile = execFile,
): Promise<BaselineResult> {
  const TRUNCATE_LEN = 4000;

  // Kill switch: opt out of baseline execution.
  if (env.AFK_DIAGNOSE_BASELINE === '0') {
    return {
      skipped: true,
      reason: 'disabled via AFK_DIAGNOSE_BASELINE=0',
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    };
  }

  // Guard: don't run if there's no command.
  if (!command || !command.trim()) {
    return {
      skipped: true,
      reason: 'no reproducer command detected',
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    };
  }

  try {
    // Run via shell so the full reproducer string (pipes, env vars, etc.) works.
    const result = await exec('/bin/sh', ['-c', command], {
      cwd,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    // Zero-exit path — reproducer passed on current code.
    return {
      skipped: false,
      exitCode: 0,
      stdout: tailTruncate(result.stdout, TRUNCATE_LEN),
      stderr: tailTruncate(result.stderr, TRUNCATE_LEN),
      timedOut: false,
    };
  } catch (err: unknown) {
    // promisified execFile rejects on non-zero exit — that IS the expected
    // baseline case (failing test/reproducer on unfixed code). Read the
    // structured error properties rather than treating this as a real error.
    const e = err as {
      code?: number | string | null;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    const exitCode = typeof e.code === 'number' ? e.code : null;
    return {
      skipped: false,
      exitCode,
      stdout: tailTruncate(e.stdout ?? '', TRUNCATE_LEN),
      stderr: tailTruncate(e.stderr ?? '', TRUNCATE_LEN),
      timedOut,
    };
  }
}

// ---------------------------------------------------------------------------
// Verifier prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the user prompt sent to the read-only verifier subagent.
 * Exported for unit testing.
 */
export function buildVerifierUserPrompt(
  hypothesis: { id: string; claim: string; location?: string; proposed_fix?: string },
  reproducer: string,
  worktreePath: string,
  baseline: BaselineResult,
): string {
  const baselineBlock = buildBaselineBlock(baseline, reproducer);
  return (
    `Test this hypothesis:\n\n` +
    `Claim: ${hypothesis.claim}\n` +
    `Location: ${hypothesis.location ?? 'unknown'}\n` +
    `Proposed fix: ${hypothesis.proposed_fix ?? 'unknown'}\n` +
    `Reproducer: ${reproducer}\n\n` +
    `Working directory (isolated): ${worktreePath}\n\n` +
    baselineBlock
  );
}

/**
 * Render the BASELINE block appended to the verifier prompt.
 */
function buildBaselineBlock(baseline: BaselineResult, reproducer: string): string {
  const lines: string[] = [
    'BASELINE (measured by the orchestrator on the CURRENT/unfixed code at the repo root — ground truth you MUST NOT contradict):',
  ];
  if (baseline.skipped) {
    lines.push(`(not run: ${baseline.reason ?? 'unknown reason'})`);
  } else {
    lines.push(`$ ${reproducer}`);
    lines.push(
      `exit code: ${baseline.exitCode ?? 'unknown'}${baseline.timedOut ? ' (TIMED OUT)' : ''}`,
    );
    lines.push('stdout (tail):');
    lines.push(baseline.stdout || '(empty)');
    lines.push('stderr (tail):');
    lines.push(baseline.stderr || '(empty)');
    if (baseline.exitCode === 0) {
      lines.push(
        'NOTE: The reproducer PASSED on the current (unfixed) code (exit 0). ' +
          'The failure may not reproduce or the reproducer may be wrong — set ' +
          '`stance: "blocks"` and lower confidence.',
      );
    }
  }
  return lines.join('\n');
}

/**
 * Schema for a single hypothesis.
 *
 * Optional `coverage_gaps` / `boundary_flag` are epistemic-confidence signals
 * matching the /agent-workflow-amplifiers:contract convention. When a sub-agent
 * populates them, the confidence gate uses them to decide whether to auto-run
 * /shadow-verify before worktree testing.
 */
export const HypothesisSchema = z.object({
  id: z.string(),
  claim: z.string(),
  confidence: z.number().min(0).max(1),
  evidence_sources: z.array(z.string()),
  location: z.string().optional(),
  proposed_fix: z.string().optional(),
  // `.nullish().transform()` accepts string | null | undefined and normalises
  // to `string | undefined` for downstream consumers (confidence-gate.ts treats
  // `undefined` as absent). The synth prompt instructs the model to emit a
  // sentinel string ("none") rather than null, but LLMs reliably emit `null`
  // anyway when the prompt says "omit when none" — so the schema is the
  // defence-in-depth layer that prevents the whole synthesis from failing
  // validation just because one optional field came back as null. See
  // src/skills/diagnose/prompts/hypothesis.md for the paired prompt change.
  coverage_gaps: z.array(z.string()).nullish().transform((v) => v ?? undefined),
  boundary_flag: z.string().nullish().transform((v) => v ?? undefined),
});

export type Hypothesis = z.infer<typeof HypothesisSchema>;

/**
 * Schema for a premise verification — the output of auto-invoked /shadow-verify
 * against a gated hypothesis. Surfaced in DiagnosisResult so callers see which
 * hypotheses were re-checked and what the verifier said.
 */
export const PremiseVerificationSchema = z.object({
  hypothesis_id: z.string(),
  claim: z.string(),
  verdict: z.enum(['VERIFIED', 'REFUTED', 'INCONCLUSIVE']),
  evidence: z.string(),
  gate_reason: z.string(),
});

export type PremiseVerification = z.infer<typeof PremiseVerificationSchema>;

/**
 * Schema for hypothesis verification result.
 */
export const VerificationResultSchema = z.object({
  hypothesis_id: z.string(),
  // Static code-reading prediction: true if the fix is predicted to make the
  // reproducer pass based on reading code; false otherwise. This is NOT an
  // executed test result — the verifier runs read-only (Edit/Write/Bash disabled).
  predicted_pass: z.boolean(),
  regressions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  verification_log: z.string(),
});

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

/**
 * Failure-type taxonomy from Phase 1 triage. Used to specialize downstream
 * agent prompts.
 */
export const FailureTypeSchema = z.enum([
  'crash',
  'regression',
  'logic-error',
  'flaky',
  'environment',
  'unknown',
]);

export type FailureType = z.infer<typeof FailureTypeSchema>;

/**
 * Structured triage output from Phase 1. Heuristically extracted from the
 * raw failure string + optional context; passed to all downstream agents
 * as shared anchor points.
 */
export const TriageSchema = z.object({
  failure_type: FailureTypeSchema,
  error_signature: z.string(),
  affected_area: z.string(),
});

export type Triage = z.infer<typeof TriageSchema>;

/**
 * Named outcome categories from Phase 6 routing. Lets callers branch on a
 * single field rather than re-deriving the outcome shape from
 * winner/verification_results/hypotheses lengths.
 *
 * - `clear_winner` — exactly one hypothesis passed verification with no regressions.
 * - `multiple_plausible` — ≥2 hypotheses passed; ranked by confidence desc, top
 *   surfaced as winner but caller should confirm before acting.
 * - `dissent` — ≥2 hypotheses both highly supported by Phase 3 but neither
 *   passed verification cleanly; do not act.
 * - `all_inconclusive` — no hypothesis passed verification.
 * - `no_hypotheses` — Phase 3 produced nothing testable, or all hypotheses
 *   were refuted by /shadow-verify before Phase 4.
 */
export const DiagnosisOutcomeSchema = z.enum([
  'clear_winner',
  'multiple_plausible',
  'dissent',
  'all_inconclusive',
  'no_hypotheses',
]);

export type DiagnosisOutcome = z.infer<typeof DiagnosisOutcomeSchema>;

/**
 * Schema for the complete diagnose result.
 */
export const DiagnosisResultSchema = z.object({
  reproducer: z.string().optional(),
  triage: TriageSchema.optional(),
  hypotheses: z.array(HypothesisSchema),
  premise_verifications: z.array(PremiseVerificationSchema).optional(),
  winner: z
    .object({
      hypothesis_id: z.string(),
      verification_log: z.string(),
      proposed_fix: z.string(),
    })
    .optional(),
  verification_results: z.array(VerificationResultSchema).optional(),
  outcome: DiagnosisOutcomeSchema.optional(),
  /**
   * When the winning hypothesis's proposed fix appears to span multiple
   * files (heuristic: distinct file paths mentioned in `proposed_fix` or
   * `location` fields > 2), recommend the caller route to `/spec` for
   * scoping rather than implementing inline. Advisory; caller decides.
   */
  recommended_next_skill: z.enum(['spec']).optional(),
});

export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;

/**
 * A minimal shadow-verify dispatcher signature. Accepts a batch of claims and
 * returns one Verification per claim (same order). Passed into
 * {@link autoVerifyHypotheses} so callers can stub it in tests without touching
 * the skill registry.
 */
export type VerifyBatchFn = (claims: string[]) => Promise<Verification[]>;

/**
 * Run the confidence gate over each hypothesis and, for those that trip it,
 * dispatch /shadow-verify (via the supplied {@link VerifyBatchFn}) to
 * independently re-check the claim. Returns per-hypothesis premise
 * verifications and the filtered list of hypotheses to carry into worktree
 * testing — REFUTED hypotheses are dropped; VERIFIED and INCONCLUSIVE are kept.
 *
 * Auto-verify is advisory: if the dispatcher throws, gated hypotheses are
 * marked INCONCLUSIVE with the error recorded in `evidence`, and no
 * hypothesis is dropped. Never throws.
 */
export async function autoVerifyHypotheses(
  hypotheses: Hypothesis[],
  verify: VerifyBatchFn,
): Promise<{
  premise_verifications: PremiseVerification[];
  hypotheses_to_test: Hypothesis[];
}> {
  const gated = hypotheses
    .map((hypothesis) => ({ hypothesis, decision: shouldAutoVerify(hypothesis) }))
    .filter((entry) => entry.decision.verify);

  if (gated.length === 0) {
    return { premise_verifications: [], hypotheses_to_test: hypotheses };
  }

  let verifications: Verification[] = [];
  let dispatchError: string | undefined;
  try {
    const result = await verify(gated.map((g) => g.hypothesis.claim));
    // Contract: VerifyBatchFn is typed to return Verification[], but the real
    // dispatcher parses an external sub-agent's output — a buggy or surprising
    // implementation could resolve to undefined / a non-array. Coerce so the
    // positional `verifications[i]` access below can never throw; missing
    // entries fall through to the INCONCLUSIVE "no verifier result" branch.
    // This is what makes the documented "Never throws" guarantee hold.
    verifications = Array.isArray(result) ? result : [];
  } catch (err) {
    dispatchError = err instanceof Error ? err.message : String(err);
  }

  const premise_verifications: PremiseVerification[] = gated.map((entry, i) => {
    const v = verifications[i];
    if (dispatchError !== undefined) {
      return {
        hypothesis_id: entry.hypothesis.id,
        claim: entry.hypothesis.claim,
        verdict: 'INCONCLUSIVE' as const,
        evidence: `shadow-verify dispatch failed: ${dispatchError}`,
        gate_reason: entry.decision.reason,
      };
    }
    if (!v) {
      return {
        hypothesis_id: entry.hypothesis.id,
        claim: entry.hypothesis.claim,
        verdict: 'INCONCLUSIVE' as const,
        evidence: 'no verifier result for this claim',
        gate_reason: entry.decision.reason,
      };
    }
    return {
      hypothesis_id: entry.hypothesis.id,
      claim: entry.hypothesis.claim,
      verdict: v.verdict,
      evidence: v.evidence,
      gate_reason: entry.decision.reason,
    };
  });

  const refutedIds = new Set(
    premise_verifications
      .filter((pv) => pv.verdict === 'REFUTED')
      .map((pv) => pv.hypothesis_id),
  );
  const hypotheses_to_test =
    refutedIds.size === 0
      ? hypotheses
      : hypotheses.filter((h) => !refutedIds.has(h.id));

  return { premise_verifications, hypotheses_to_test };
}

/**
 * Handler for the /diagnose skill.
 *
 * @param input - Must have `failure` (string) and `repoPath` (string);
 *                optional `context` (string) and `maxHypotheses` (number, capped at 4)
 * @param parentSession - Parent agent session (used to fork subagents)
 * @returns Parsed DiagnosisResult with hypotheses and optional winner
 */
async function handler(
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

  const manager = new SubagentManager({ apiKey });

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

/**
 * Heuristic Phase 1 triage. Classifies the failure type and extracts an
 * `error_signature` (first non-empty line of the failure, capped at 200 chars)
 * and `affected_area` (first plausible file path or module mentioned in
 * failure + context).
 *
 * Pure heuristics — no LLM call. Conservative: when in doubt, return
 * `failure_type: 'unknown'` and `affected_area: 'unknown'` rather than a
 * speculative classification. Downstream agents still receive the full
 * original failure string; this is anchor-point extraction, not summarization.
 */
export function classifyAndExtract(failure: string, context: string): Triage {
  const combined = `${failure}\n${context}`;

  // Failure-type classification: ordered priority — flaky beats regression
  // beats crash, because flaky/regression mention causal history that
  // outranks the raw symptom signature.
  let failure_type: FailureType = 'unknown';
  const lc = combined.toLowerCase();
  if (/flaky|non-?deterministic|intermittent|sometimes fails|race/.test(lc)) {
    failure_type = 'flaky';
  } else if (/regression|used to work|worked before|broke in|ci.*green.*red|was passing/.test(lc)) {
    failure_type = 'regression';
  } else if (
    /\b(uncaught|unhandled)\b|panic|segfault|exit(ed)? (with )?(code )?[1-9]|sigsegv|stack overflow|fatal|traceback|core dumped|abort(ed)?|\b(type|reference|range|syntax|internal|eval|uri)error\b/.test(
      lc,
    )
  ) {
    failure_type = 'crash';
  } else if (
    /platform|node version|python version|dependency|version mismatch|works on .* not |env(ironment)?|config drift/.test(lc)
  ) {
    failure_type = 'environment';
  } else if (/expected .* but|got .* expected|wrong|incorrect|unexpected/.test(lc)) {
    failure_type = 'logic-error';
  }

  // error_signature: first non-empty trimmed line, capped at 200 chars.
  //
  // Prose-question guard: when the first line is a natural-language question
  // (e.g. "why is X doing Y rather than Z") AND no concrete error/exception
  // tokens appear anywhere in the failure text, the question itself is NOT a
  // useful anchor — using it leaks the first salient domain noun (e.g. "X")
  // into both research lanes' triage blocks, where the LLM latches onto it
  // ahead of the actual subject of the question. Replace with a sentinel
  // ('prose-question') that downstream consumers can recognize. The full
  // failure text still reaches the agents via `Failure: ...` in the research
  // prompt — only the *anchor* is suppressed.
  //
  // When error tokens DO appear (e.g. "Why does this throw
  // NullPointerException?"), the first line stays as the anchor because the
  // question wraps a real signal and downstream agents benefit from it.
  const PROSE_QUESTION_RE =
    /^(why|what|how|when|where|who|is|are|does|did|can|could|should|would)\b/i;
  const ERROR_TOKEN_RE =
    /\b(error|exception|panic|throws?|traceback|fail(ed|ure|s)?|undefined|null|nan|segfault|sigsegv|stack ?overflow|abort(ed)?)\w*|:\s*\d+|\bat\s+\S|\bcore dumped\b/i;

  const firstLine = failure
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  let error_signature: string;
  if (!firstLine) {
    error_signature = 'unknown';
  } else if (PROSE_QUESTION_RE.test(firstLine) && !ERROR_TOKEN_RE.test(failure)) {
    error_signature = 'prose-question';
  } else if (firstLine.length > 200) {
    error_signature = `${firstLine.slice(0, 197)}...`;
  } else {
    error_signature = firstLine;
  }

  // affected_area: first file-path-shaped token mentioned. Looks for
  // path-like patterns: 'src/foo.ts', './bar.js', 'a/b/c.py:42', etc.
  // Falls back to 'unknown'. Conservative — does not infer module names.
  const pathMatch = combined.match(
    /(?:^|[\s'"`(])((?:\.{1,2}\/)?[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cpp|c|h|hpp|md|json|yaml|yml)(?::\d+(?::\d+)?)?)/,
  );
  const affected_area = pathMatch?.[1] ?? 'unknown';

  return { failure_type, error_signature, affected_area };
}

/**
 * Heuristic: does the proposed fix span more than 2 distinct files?
 * Inspects the winning hypothesis's `proposed_fix` and `location` for
 * file-path-shaped tokens. >2 distinct paths → recommend `/spec` for
 * scoping rather than inline implementation.
 *
 * Conservative — returns false when nothing path-shaped is found, so we
 * don't spuriously recommend `/spec` for fixes described abstractly.
 */
export function fixSpansMultipleFiles(hypothesis: Hypothesis): boolean {
  const text = `${hypothesis.proposed_fix ?? ''}\n${hypothesis.location ?? ''}`;
  const matches = text.match(
    /(?:^|[\s'"`(])((?:\.{1,2}\/)?[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cpp|c|h|hpp))/g,
  );
  if (!matches) return false;
  const distinct = new Set(matches.map((m) => m.trim().replace(/^[\s'"`(]+/, '').split(':')[0]));
  return distinct.size > 2;
}

/**
 * Compute the routing outcome from the diagnose pipeline's terminal state.
 *
 * Decision table:
 * - 0 hypotheses (or all REFUTED in Phase 3.5) → `no_hypotheses`
 * - 0 passes in Phase 4:
 *   - ≥2 hypotheses with Phase-3 confidence ≥ 0.7 → `dissent`
 *   - else → `all_inconclusive`
 * - 1 pass → `clear_winner`
 * - ≥2 passes → `multiple_plausible`
 */
export function computeOutcome(
  hypotheses: Hypothesis[],
  verificationResults: VerificationResult[],
): DiagnosisOutcome {
  if (hypotheses.length === 0) return 'no_hypotheses';
  const passes = verificationResults.filter(
    (r) => r.predicted_pass && r.regressions.length === 0,
  );
  if (passes.length === 1) return 'clear_winner';
  if (passes.length >= 2) return 'multiple_plausible';
  // Zero passes. Distinguish dissent (multiple strong Phase-3 claims that
  // both failed verification) from all_inconclusive (weak claims that failed).
  const strong = hypotheses.filter((h) => h.confidence >= 0.7);
  if (strong.length >= 2) return 'dissent';
  return 'all_inconclusive';
}

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

export const diagnoseSkill: SkillMetadata = {
  name: 'diagnose',
  description:
    'Parallel root-cause analysis for bugs and failing tests — forks research subagents, synthesizes hypotheses, and validates each in isolated worktrees',
  handler,
  argumentHint: '<bug-or-failing-test>',
  whenToUse: 'When a test is failing, a bug is reported, or behavior is unexplained — runs parallel root-cause analysis with hypothesis sub-agents.',
};

registerSkill(diagnoseSkill);
