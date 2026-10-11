/**
 * Public surface of src/agent/outcomes/.
 *
 * Re-exports the schema, artifact recovery, immediate/delayed LFs, and
 * the v1 combiner. Consumers import from this barrel, not sub-modules.
 */

export type { VerifiedOutcome, OutcomeLabel, SelfReport, Vote } from './schema.js';

export { recoverArtifacts } from './artifacts.js';

export { lfClosure, runImmediateLFs } from './lf-immediate.js';

export { lfPrFate, lfCommitSurvival } from './lf-delayed.js';

export { combine } from './combine.js';

export { createOutcomeSessionEndHook } from './session-end-hook.js';
export { createChildAttributionHook } from './child-attribution.js';
