/**
 * Public surface of src/agent/outcomes/.
 *
 * Re-exports the schema, artifact recovery, immediate/delayed LFs, and
 * the v1 combiner. Consumers import from this barrel, not sub-modules.
 */

export type { VerifiedOutcome, OutcomeLabel, SelfReport, Vote, HistoryEntry, Artifacts } from './schema.js';
export { VerifiedOutcomeSchema } from './schema.js';

export type { ToolEvent, Turn } from './artifacts.js';
export { recoverArtifacts, recoverCommitSHAs, recoverPRURLs, inferRepo } from './artifacts.js';

export type { ClosureInfo, LoadClosure, ImmediateLFResult } from './lf-immediate.js';
export {
  parseSelfReport,
  lfClosure,
  lfErrorTail,
  lfVerification,
  lfInSessionCorrection,
  lfSelfReport,
  runImmediateLFs,
} from './lf-immediate.js';

export type { PrState, FetchPrState, CheckAncestor, CheckRevert, GetDefaultBranch } from './lf-delayed.js';
export {
  parsePrUrl,
  lfPrFate,
  lfCommitSurvival,
  lfFixOfFix,
  realFetchPrState,
  realCheckAncestor,
  realCheckRevert,
} from './lf-delayed.js';

export type { CombinerInput, CombinerResult } from './combine.js';
export { combine, computeConfidence } from './combine.js';

export {
  VERIFICATION_PATTERNS,
  isVerificationCommand,
  parseVerificationSummary,
} from './verification-patterns.js';

export type { UpsertVotesOptions } from './store.js';
export { readRecord, writeRecord, listRecords, upsertVotes, appendArtifacts } from './store.js';

export { createOutcomeSessionEndHook } from './session-end-hook.js';
export { createChildAttributionHook } from './child-attribution.js';
// promptFingerprint and FINGERPRINT_MAX_TOKENS are intentionally NOT re-exported
// here: they are internal implementation details used only inside lf-reask.ts
// and session-end-hook.ts (which imports directly). Exposing them as public API
// would imply a stability contract we do not want to make (issue #2561).
export { lfReask, normalizeTokens, jaccardSimilarity, REASK_THRESHOLD } from './lf-reask.js';

export type { ExecFnCi } from './lf-ci.js';
export { lfCi, realExecFnCi } from './lf-ci.js';

export type { ExecFnFof } from './lf-fof.js';
export { lfFixOfFix as lfFixOfFixDelayed, realExecFnFof } from './lf-fof.js';

export type { RelabelDeps, RelabelJobOptions, RelabelJobResult, ProcessResult } from './relabel-job.js';
export { runRelabelJob, processRecord, realRelabelDeps } from './relabel-job.js';
