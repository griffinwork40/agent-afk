/**
 * Public surface of src/agent/outcomes/.
 *
 * Re-exports the schema, artifact recovery, immediate/delayed LFs, and
 * the v1 combiner. Runtime consumers import from this barrel; scripts/
 * imports types directly from sub-modules (e.g. scripts/update-facets.ts).
 */

export type { VerifiedOutcome, OutcomeLabel, SelfReport, Vote } from './schema.js';

export { recoverArtifacts } from './artifacts.js';

export { lfClosure, runImmediateLFs } from './lf-immediate.js';

export { lfPrFate, lfCommitSurvival } from './lf-delayed.js';

export { combine } from './combine.js';

export { createOutcomeSessionEndHook } from './session-end-hook.js';
export { createChildAttributionHook } from './child-attribution.js';

export { computeOutcomes } from './compute-outcomes.js';
export type { ComputeOutcomesInput, GitLogEntry } from './compute-outcomes.js';
export { gitLogRange } from './git-range.js';
export { OutcomesV1Schema } from './outcomes-v1.schema.js';
export type { OutcomesV1 } from './outcomes-v1.schema.js';
