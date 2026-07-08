/**
 * Zod schemas and inferred types for the /diagnose skill.
 *
 * All schema definitions and their inferred TypeScript types live here so
 * downstream phase modules and tests can import from a single, stable location
 * without depending on the full orchestrator index.
 *
 * @module skills/diagnose/_phases/types
 */

import { z } from 'zod';

export interface Verification {
  claim: string;
  verdict: 'VERIFIED' | 'REFUTED' | 'INCONCLUSIVE';
  evidence: string;
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
  // Distinguishes a verifier that exhausted its wall-clock budget
  // (VERIFIER_TIMEOUT_MS) from one that genuinely falsified the hypothesis:
  // both otherwise collapse to `predicted_pass: false, confidence: 0`, so a
  // consumer reading only those two fields cannot tell "ran out of time" apart
  // from "disproven". Optional because the verifier subagent never emits it (it
  // reports substantive verdicts only), so absent/undefined means "not a
  // timeout"; the orchestrator sets `true` when a fork fails with a TimeoutError.
  timed_out: z.boolean().optional(),
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
 * Tolerant shape for the verification envelope diagnose asks shadow-verify to
 * append. Only `verdict` is required; `claim`/`evidence` are optional because
 * the prose skill is merely *asked* to follow the contract — we backfill
 * defaults rather than reject a near-miss.
 */
export const ShadowVerifyEnvelopeSchema = z.object({
  verifications: z.array(
    z.object({
      claim: z.string().optional(),
      verdict: z.string(),
      evidence: z.string().optional(),
    }),
  ),
});

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
