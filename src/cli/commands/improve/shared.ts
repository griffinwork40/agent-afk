import type { FailurePattern } from '../../../improve/schemas.js';
import { FailurePatternSchema } from '../../../improve/schemas.js';

// Invariant: DERIVED from the canonical schema, never hand-maintained. A
// hand-copied duplicate drifted two sprints behind `FailurePatternSchema`, so
// `--pattern tool-failure-density` was rejected while cards on disk used it.
export const VALID_PATTERNS: readonly FailurePattern[] = FailurePatternSchema.options;
