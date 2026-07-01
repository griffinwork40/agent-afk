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

// Re-export all public types, schemas, and functions from phase modules so
// external importers (tests, callers) continue to resolve from this index.
export type {
  Verification,
  Hypothesis,
  PremiseVerification,
  VerificationResult,
  DiagnosisResult,
  VerifyBatchFn,
  BaselineResult,
  FailureType,
  Triage,
  DiagnosisOutcome,
} from './_phases/types.js';

export {
  HypothesisSchema,
  PremiseVerificationSchema,
  VerificationResultSchema,
  FailureTypeSchema,
  TriageSchema,
  DiagnosisOutcomeSchema,
  DiagnosisResultSchema,
} from './_phases/types.js';

export { classifyAndExtract, fixSpansMultipleFiles, computeOutcome } from './_phases/triage.js';

export {
  parseShadowVerifyOutput,
  runReproducerBaseline,
  buildVerifierUserPrompt,
  autoVerifyHypotheses,
} from './_phases/verifier.js';

export {
  createReadOnlyCanUseTool,
  createGitLaneCanUseTool,
  createVerifierCanUseTool,
} from './_phases/orchestrator.js';

import { handler } from './_phases/orchestrator.js';
import { registerSkill, type SkillMetadata } from '../index.js';

export const diagnoseSkill: SkillMetadata = {
  name: 'diagnose',
  description:
    'Parallel root-cause analysis for bugs and failing tests — forks research subagents, synthesizes hypotheses, and validates each in isolated worktrees',
  handler,
  argumentHint: '<bug-or-failing-test>',
  whenToUse: 'When a test is failing, a bug is reported, or behavior is unexplained — runs parallel root-cause analysis with hypothesis sub-agents.',
};

registerSkill(diagnoseSkill);
