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
